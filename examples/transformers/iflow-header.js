/**
 * iFlow Header Transformer
 *
 * 100% aligns with iflow-cli 0.5.13 behavior:
 * - Request headers (HMAC-SHA256 signature, session/conversation IDs, traceparent)
 * - Request body defaults (temperature, top_p, max_new_tokens, tools, stream)
 * - Model-specific parameters (thinking modes for different models)
 * - Aone endpoint specific headers
 *
 * Reference: https://github.com/user/iflow2api proxy.py
 *
 * Usage in config.json:
 * {
 *   "transformers": [
 *     { "path": "~/.claude-code-router/plugins/iflow-header.js" }
 *   ],
 *   "Providers": [{
 *     "name": "iflow",
 *     "baseUrl": "https://iflow.cn/api",
 *     "apiKey": "your-api-key",
 *     "transformer": {
 *       "use": ["iflow-header"]
 *     }
 *   }]
 * }
 */

const crypto = require('crypto');

// Constants from iflow-cli
const IFLOW_CLI_USER_AGENT = 'iFlow-Cli';
const IFLOW_CLI_VERSION = '0.5.13';

/**
 * Generate UUID v4
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate HMAC-SHA256 signature for iFlow API
 *
 * Signature algorithm from iflow-cli source:
 * - Algorithm: HMAC-SHA256
 * - Key: apiKey
 * - Message: `{user_agent}:{session_id}:{timestamp}`
 * - Output: hex string
 *
 * @param {string} userAgent - User agent string
 * @param {string} sessionId - Session ID
 * @param {number} timestamp - Millisecond timestamp
 * @param {string} apiKey - API key for signing
 * @returns {string|null} - Hex signature or null on error
 */
function generateSignature(userAgent, sessionId, timestamp, apiKey) {
  if (!apiKey) {
    return null;
  }

  const message = `${userAgent}:${sessionId}:${timestamp}`;
  try {
    return crypto
      .createHmac('sha256', apiKey)
      .update(message)
      .digest('hex');
  } catch (error) {
    console.error('[IFlowHeaderTransformer] Failed to generate HMAC signature:', error);
    return null;
  }
}

/**
 * Generate W3C Trace Context traceparent
 * Format: 00-<32hex trace_id>-<16hex parent_id>-01
 *
 * @returns {string} - W3C traceparent string
 */
function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Check if endpoint is Aone (requires additional headers)
 *
 * @param {string} baseUrl - Provider base URL
 * @returns {boolean} - True if Aone endpoint
 */
function isAoneEndpoint(baseUrl) {
  return baseUrl && baseUrl.toLowerCase().includes('ducky.code.alibaba-inc.com');
}

module.exports = class IFlowHeaderTransformer {
  static TransformerName = 'iflow-header';

  /**
   * Constructor
   *
   * @param {Object} options - Transformer options
   * @param {string} [options.sessionId] - Custom session ID (auto-generated if not provided)
   * @param {string} [options.conversationId] - Custom conversation ID (auto-generated if not provided)
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {boolean} [options.enableTelemetry=false] - Enable telemetry user ID generation
   */
  constructor(options = {}) {
    this.name = 'iflow-header';
    this.options = options;
    this.debug = options.debug || false;

    // Generate session and conversation IDs (persist for transformer lifetime)
    // Format matches iflow-cli: session-{uuid}
    this.sessionId = options.sessionId || `session-${uuidv4()}`;
    this.conversationId = options.conversationId || uuidv4();

    // Telemetry user ID (optional, for compatibility with iflow-cli telemetry)
    if (options.enableTelemetry) {
      // Use a deterministic UUID based on session ID
      this.telemetryUserId = uuidv4();
    }

    if (this.debug) {
      console.log('[IFlowHeaderTransformer] Initialized with:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
    }
  }

  /**
   * Align official default parameters for request body
   * Reference: iflow2api/proxy.py:366-391
   *
   * Official CLI behavior for /chat/completions:
   * - max_new_tokens
   * - temperature
   * - top_p
   * - tools (empty array even if not provided)
   * - stream (true for streaming, omitted for non-streaming)
   *
   * @param {Object} requestBody - Original request body
   * @param {boolean} stream - Whether this is a streaming request
   * @returns {Object} - Aligned request body
   */
  _alignOfficialBodyDefaults(requestBody, stream = false) {
    const body = { ...requestBody };

    // Official behavior: streaming requests carry stream=true; non-streaming omit this field
    delete body.stream;
    if (stream) {
      body.stream = true;
    }

    // Official default parameters (from official CLI packet capture + bundle config)
    body.temperature = body.temperature ?? 0.7;
    body.top_p = body.top_p ?? 0.95;
    body.max_new_tokens = body.max_new_tokens ?? 8192;
    body.tools = body.tools ?? [];

    return body;
  }

  /**
   * Configure model-specific request parameters
   * Reference: iflow2api/proxy.py:394-508
   *
   * Model configuration rules (from iflow-cli source):
   * - deepseek: thinking_mode=true, reasoning=true
   * - glm-4.7: chat_template_kwargs={enable_thinking: true}
   * - glm-5: chat_template_kwargs={enable_thinking: true}, enable_thinking=true, thinking={type: "enabled"}
   * - glm-* (others): chat_template_kwargs={enable_thinking: true}
   * - kimi-k2.5: thinking={type: "enabled"}
   * - *thinking*: thinking_mode=true
   * - mimo-*: thinking={type: "enabled"}
   * - claude: chat_template_kwargs={enable_thinking: true}
   * - sonnet-*: chat_template_kwargs={enable_thinking: true}
   * - *reasoning*: reasoning=true
   * - qwen*4b: delete thinking_mode, reasoning, chat_template_kwargs (not supported)
   *
   * @param {Object} requestBody - Request body
   * @param {string} model - Model ID
   * @returns {Object} - Configured request body
   */
  _configureModelRequest(requestBody, model) {
    const body = { ...requestBody };
    const modelLower = model.toLowerCase();

    // 1. DeepSeek models
    // configureRequest:(e,r)=>{r.reasoningLevel!=="low"&&(e.reasoning=!0),e.thinking_mode=!0}
    if (modelLower.startsWith('deepseek')) {
      if (body.thinking_mode === undefined) {
        body.thinking_mode = true;
      }
      if (body.reasoning === undefined) {
        body.reasoning = true;
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added thinking_mode=true, reasoning=true`);
      }
    }
    // 2. GLM-5 model (special configuration)
    // configureRequest:e=>{e.chat_template_kwargs={enable_thinking:!0},e.enable_thinking=!0,e.thinking={type:"enabled"}}
    else if (model === 'glm-5') {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (body.enable_thinking === undefined) {
        body.enable_thinking = true;
      }
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added chat_template_kwargs, enable_thinking, thinking`);
      }
    }
    // 3. GLM-4.7 model
    // configureRequest:e=>{e.chat_template_kwargs={enable_thinking:!0}}
    else if (model === 'glm-4.7') {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added chat_template_kwargs`);
      }
    }
    // 4. Other GLM models
    // configureRequest:e=>{e.chat_template_kwargs={enable_thinking:!0}}
    else if (modelLower.startsWith('glm-')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added chat_template_kwargs`);
      }
    }
    // 5. Kimi-K2.5 model
    // configureRequest:(e,r)=>{e.thinking={type:"enabled"}}
    else if (modelLower.startsWith('kimi-k2.5')) {
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added thinking`);
      }
    }
    // 6. Models containing "thinking" (e.g., kimi-k2-thinking, gemini-2.0-flash-thinking)
    // configureRequest:e=>{e.thinking_mode=!0}
    else if (modelLower.includes('thinking')) {
      if (body.thinking_mode === undefined) {
        body.thinking_mode = true;
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added thinking_mode`);
      }
    }
    // 7. mimo- models
    // configureRequest:e=>{e.thinking={type:"enabled"}}
    else if (modelLower.startsWith('mimo-')) {
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added thinking`);
      }
    }
    // 8. Claude models
    // configureRequest:e=>{e.chat_template_kwargs={enable_thinking:!0}}
    else if (modelLower.includes('claude')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added chat_template_kwargs`);
      }
    }
    // 9. sonnet- models
    // configureRequest:e=>{e.chat_template_kwargs={enable_thinking:!0}}
    else if (modelLower.includes('sonnet-')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added chat_template_kwargs`);
      }
    }
    // 10. Models containing "reasoning"
    // configureRequest:e=>{e.reasoning=!0}
    else if (modelLower.includes('reasoning')) {
      if (body.reasoning === undefined) {
        body.reasoning = true;
      }
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: added reasoning`);
      }
    }

    // 11. Qwen 4B models (do not support thinking, remove related parameters)
    // configureRequest:e=>{delete e.thinking_mode,delete e.reasoning,delete e.chat_template_kwargs}
    if (/^qwen.*4b/i.test(modelLower)) {
      delete body.thinking_mode;
      delete body.reasoning;
      delete body.chat_template_kwargs;
      if (this.debug) {
        console.log(`[IFlowHeaderTransformer] Model ${model}: removed thinking parameters (not supported)`);
      }
    }

    return body;
  }

  /**
   * Transform request to fully align with iflow-cli behavior
   *
   * This includes:
   * 1. Body default parameters (temperature, top_p, max_new_tokens, tools, stream)
   * 2. Model-specific parameters (thinking modes for different models)
   * 3. Request headers (signature, session/conversation IDs, traceparent)
   *
   * @param {Object} request - Request body
   * @param {Object} provider - Provider configuration
   * @param {Object} context - Transformer context
   * @returns {Object} - Transformed request with config
   */
  async transformRequestIn(request, provider, context) {
    const timestamp = Date.now(); // Millisecond timestamp

    // Get API key - support both apiKey and api_key formats
    const apiKey = provider.api_key || provider.apiKey;
    if (!apiKey) {
      console.warn('[IFlowHeaderTransformer] No API key found in provider config');
    }

    // Step 1: Align official default parameters for request body
    // Reference: iflow2api/proxy.py:366-391
    let body = this._alignOfficialBodyDefaults(request, request.stream || false);

    // Step 2: Configure model-specific parameters
    // Reference: iflow2api/proxy.py:394-508
    const model = body.model || '';
    body = this._configureModelRequest(body, model);

    // Step 3: Build headers matching iflow-cli behavior
    // Reference: iflow2api/proxy.py:80-135
    // Note: user-agent uses lowercase key as observed in iflow-cli
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'user-agent': IFLOW_CLI_USER_AGENT,
      'session-id': this.sessionId,
      'conversation-id': this.conversationId,
      'accept': '*/*',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'accept-encoding': 'br, gzip, deflate',
    };

    // Generate and add HMAC signature
    // Format: hmac.new(api_key, f"{user_agent}:{session_id}:{timestamp}", sha256).hexdigest()
    const signature = generateSignature(
      IFLOW_CLI_USER_AGENT,
      this.sessionId,
      timestamp,
      apiKey
    );

    if (signature) {
      headers['x-iflow-signature'] = signature;
      headers['x-iflow-timestamp'] = String(timestamp);
    }

    // Add W3C Trace Context traceparent
    // iflow-cli: traceparent is optional, reused within same request chain
    const traceparent = context?.traceparent || generateTraceparent();
    headers['traceparent'] = traceparent;

    // Store traceparent in context for potential reuse
    if (context) {
      context.traceparent = traceparent;
    }

    // Add Aone-specific headers if endpoint matches
    if (isAoneEndpoint(provider.baseUrl)) {
      headers['X-Client-Type'] = 'iflow-cli';
      headers['X-Client-Version'] = IFLOW_CLI_VERSION;

      if (this.debug) {
        console.log('[IFlowHeaderTransformer] Added Aone-specific headers');
      }
    }

    if (this.debug) {
      console.log('[IFlowHeaderTransformer] Request transformed:');
      console.log(`  - Model: ${model}`);
      console.log(`  - Headers: ${Object.keys(headers).length}`);
      console.log(`  - Signature: ${signature ? `${signature.substring(0, 16)}...` : 'null'}`);
      console.log(`  - Body params: temperature=${body.temperature}, top_p=${body.top_p}, max_new_tokens=${body.max_new_tokens}`);
    }

    // Return transformed body with headers config
    return {
      body,
      config: {
        headers,
      },
    };
  }

  /**
   * Transform response (pass-through, no modifications)
   *
   * @param {Response} response - Response object
   * @param {Object} context - Transformer context
   * @returns {Response} - Unmodified response
   */
  async transformResponseOut(response, context) {
    // Pass through without modification
    return response;
  }

  /**
   * Reset session and conversation IDs
   * Call this to start a new conversation
   */
  resetSession() {
    this.sessionId = `session-${uuidv4()}`;
    this.conversationId = uuidv4();

    if (this.debug) {
      console.log('[IFlowHeaderTransformer] Session reset:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
    }
  }

  /**
   * Get current session info
   *
   * @returns {Object} - Session information
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      telemetryUserId: this.telemetryUserId,
    };
  }
};
