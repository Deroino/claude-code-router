/**
 * iFlow Transformer (Header + Telemetry)
 *
 * Complete simulation of iflow-cli 0.5.13 behavior:
 * 1. Request headers (HMAC-SHA256 signature, session/conversation IDs, traceparent)
 * 2. Request body defaults (temperature, top_p, max_new_tokens, tools, stream)
 * 3. Model-specific parameters (thinking modes for different models)
 * 4. Telemetry events (gm.mmstat.com lifecycle + log.mmstat.com APlus)
 *
 * Reference: Packet capture of official iflow-cli 0.5.13
 *
 * Usage in config.json:
 * {
 *   "transformers": [
 *     { "path": "~/.claude-code-router/plugins/iflow.js" }
 *   ],
 *   "Providers": [{
 *     "name": "iflow",
 *     "baseUrl": "https://apis.iflow.cn/v1/chat/completions",
 *     "apiKey": "your-api-key",
 *     "transformer": {
 *       "use": ["iflow"]
 *     }
 *   }]
 * }
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');

// ============================================================================
// Constants from packet capture
// ============================================================================

const IFLOW_CLI_USER_AGENT = 'iFlow-Cli';
const IFLOW_CLI_VERSION = '0.5.13';

const TELEMETRY_ENDPOINTS = {
  lifecycle: 'gm.mmstat.com',
  aplus: 'log.mmstat.com',
  platform: 'platform.iflow.cn',
  iflow: 'iflow.cn',
};

const TELEMETRY_PATHS = {
  runStarted: '//aitrack.lifecycle.run_started',
  runFinished: '//aitrack.lifecycle.run_finished',
  aplusGif: '/v.gif',
  queryHighQuality: '/api/openapi/queryHighQuality',
  adPhrases: '/cli/ad-phrases',
};

// Default device fingerprint (can be overridden in options)
const DEFAULT_CNA = 'IrupIXR+QlMBASQJilXIjJma';
const DEFAULT_SPM_CNT = 'a2110qe.32214347.46097794.0.0';

// ============================================================================
// Helper Functions
// ============================================================================

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
 * Derive deterministic userId (UUID format) from apiKey
 */
function deriveUserId(apiKey) {
  const hash = crypto.createHash('sha256').update(`iflow:user:${apiKey}`).digest();
  const b = Buffer.from(hash.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/**
 * Derive deterministic cna (24 chars, base64-like) from apiKey
 */
function deriveCna(apiKey) {
  const hash = crypto.createHash('sha256').update(`iflow:cna:${apiKey}`).digest();
  return hash.slice(0, 18).toString('base64').replace(/=+$/, '');
}

/**
 * Generate 16-char hex observation ID
 */
function generateObservationId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate random cache key (6-7 hex chars)
 */
function generateCacheKey() {
  return Math.random().toString(16).substring(2, 9);
}

/**
 * Generate HMAC-SHA256 signature for iFlow API
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
    console.error('[IFlowTransformer] Failed to generate HMAC signature:', error);
    return null;
  }
}

/**
 * Generate W3C Trace Context traceparent
 * Format: 00-<32hex trace_id>-<16hex parent_id>-01
 */
function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Check if endpoint is Aone (requires additional headers)
 */
function isAoneEndpoint(baseUrl) {
  return baseUrl && baseUrl.toLowerCase().includes('ducky.code.alibaba-inc.com');
}

/**
 * Send HTTP POST request (fire-and-forget style)
 */
function sendTelemetry(host, path, body, contentType = 'application/json', debug = false) {
  return new Promise((resolve) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);

    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(postData),
        'user-agent': 'node',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
      },
    };

    if (debug) {
      console.log(`[IFlowTransformer][Telemetry] POST https://${host}${path}`);
      console.log(`[IFlowTransformer][Telemetry] Body: ${postData.substring(0, 200)}...`);
    }

    const req = https.request(options, (res) => {
      if (debug) {
        console.log(`[IFlowTransformer][Telemetry] Response: ${res.statusCode}`);
      }
      resolve({ statusCode: res.statusCode });
    });

    req.on('error', (e) => {
      if (debug) {
        console.error(`[IFlowTransformer][Telemetry] Error: ${e.message}`);
      }
      resolve({ error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Send HTTP GET request (fire-and-forget style, for startup simulation)
 */
function sendHttpGet(host, path, headers = {}, debug = false) {
  return new Promise((resolve) => {
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'GET',
      headers: {
        'host': host,
        'connection': 'keep-alive',
        'accept': '*/*',
        'accept-language': '*',
        'sec-fetch-mode': 'cors',
        'user-agent': 'node',
        'accept-encoding': 'br, gzip, deflate',
        ...headers,
      },
    };

    if (debug) {
      console.log(`[IFlowTransformer][Startup] GET https://${host}${path}`);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (debug) {
          console.log(`[IFlowTransformer][Startup] Response: ${res.statusCode} (${data.length} bytes)`);
        }
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', (e) => {
      if (debug) {
        console.error(`[IFlowTransformer][Startup] Error: ${e.message}`);
      }
      resolve({ error: e.message });
    });

    req.end();
  });
}

// ============================================================================
// Main Transformer Class
// ============================================================================

module.exports = class IFlowTransformer {
  static TransformerName = 'iflow';

  /**
   * Constructor
   *
   * @param {Object} options - Transformer options
   * @param {string} [options.sessionId] - Custom session ID
   * @param {string} [options.conversationId] - Custom conversation ID
   * @param {string} [options.userId] - Persistent user ID for telemetry
   * @param {string} [options.cna] - Device fingerprint
   * @param {string} [options.spmCnt] - SPM tracking coordinates
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {boolean} [options.enableTelemetry=true] - Enable telemetry sending
   */
  constructor(options = {}) {
    this.name = 'iflow-reverse';
    this.options = options;
    this.debug = options.debug || false;
    this.enableTelemetry = options.enableTelemetry !== false;

    // Session and conversation IDs
    this.sessionId = options.sessionId || `session-${uuidv4()}`;
    this.conversationId = options.conversationId || uuidv4();

    // Telemetry user ID (should be persisted across restarts)
    this.userId = options.userId || uuidv4();
    this.cna = options.cna || DEFAULT_CNA;
    this.spmCnt = options.spmCnt || DEFAULT_SPM_CNT;

    // System info for APlus
    this.systemInfo = {
      platformType: 'pc',
      deviceModel: os.type() || 'Linux',
      os: os.type() || 'Linux',
      o: os.platform() || 'linux',
      nodeVersion: process.version,
      language: process.env.LANG || process.env.LANGUAGE || 'C.UTF-8',
    };

    // Startup simulation flag (queryHighQuality + ad-phrases)
    this.startupSimulated = false;

    if (this.debug) {
      console.log('[IFlowTransformer] Initialized with:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
      console.log(`  - userId: ${this.userId}`);
      console.log(`  - enableTelemetry: ${this.enableTelemetry}`);
    }
  }

  /**
   * Build gokey string for lifecycle events
   */
  _buildGokey(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join('&');
  }

  /**
   * Send run_started lifecycle event
   */
  async sendRunStarted(context) {
    if (!this.enableTelemetry) return {};

    const {
      sessionId,
      conversationId,
      traceId,
      model,
      tool = '',
      userId,
    } = context;

    const observationId = generateObservationId();
    const sam = `iflow.cli.${conversationId}.${traceId}`;

    const gokey = this._buildGokey({
      pid: 'iflow',
      sam,
      trace_id: traceId,
      session_id: sessionId,
      conversation_id: conversationId,
      observation_id: observationId,
      model,
      tool,
      user_id: userId,
    });

    const body = {
      gmkey: 'AI',
      gokey,
    };

    const trackingInfo = {
      observationId,
      sam,
      traceId,
      sessionId,
      conversationId,
      model,
      startTime: Date.now(),
    };

    // Send asynchronously
    sendTelemetry(
      TELEMETRY_ENDPOINTS.lifecycle,
      TELEMETRY_PATHS.runStarted,
      body,
      'application/json',
      this.debug
    );

    return trackingInfo;
  }

  /**
   * Send run_finished lifecycle event
   */
  async sendRunFinished(context, trackingInfo) {
    if (!this.enableTelemetry) return;

    const {
      sessionId,
      conversationId,
      traceId,
      model,
      tool = '',
      userId,
    } = context;

    const {
      observationId: parentObservationId,
      sam,
      startTime,
    } = trackingInfo;

    const observationId = generateObservationId();
    const duration = Date.now() - startTime;

    const gokey = this._buildGokey({
      pid: 'iflow',
      sam,
      trace_id: traceId,
      session_id: sessionId,
      conversation_id: conversationId,
      observation_id: observationId,
      parent_observation_id: parentObservationId,
      duration,
      model,
      tool,
      sessionId: sessionId,
      user_id: userId,
    });

    const body = {
      gmkey: 'AI',
      gokey,
    };

    sendTelemetry(
      TELEMETRY_ENDPOINTS.lifecycle,
      TELEMETRY_PATHS.runFinished,
      body,
      'application/json',
      this.debug
    );
  }

  /**
   * Send APlus log event
   */
  async sendAplusLog(context) {
    if (!this.enableTelemetry) return;

    const { userId, cna } = context;

    const params = new URLSearchParams({
      logtype: '1',
      title: 'iFlow-CLI',
      pre: '-',
      scr: '-',
      cna: cna,
      'spm-cnt': this.spmCnt,
      aplus: '',
      pid: 'iflow',
      _user_id: userId,
      cache: generateCacheKey(),
      sidx: 'aplusSidex',
      ckx: 'aplusCkx',
      platformType: this.systemInfo.platformType,
      device_model: this.systemInfo.deviceModel,
      os: this.systemInfo.os,
      o: this.systemInfo.o,
      node_version: this.systemInfo.nodeVersion,
      language: this.systemInfo.language,
      interactive: '1',
      iFlowEnv: '',
      _g_encode: 'utf-8',
    });

    sendTelemetry(
      TELEMETRY_ENDPOINTS.aplus,
      TELEMETRY_PATHS.aplusGif,
      params.toString(),
      'text/plain;charset=UTF-8',
      this.debug
    );
  }

  /**
   * Simulate CLI startup requests (queryHighQuality + ad-phrases)
   * Called once per apiKey on first request
   */
  async _simulateStartup(apiKey) {
    if (!this.enableTelemetry) return;

    // 1. Query user privileges (platform.iflow.cn)
    const qualityPath = `${TELEMETRY_PATHS.queryHighQuality}?apiKey=${encodeURIComponent(apiKey)}`;
    sendHttpGet(
      TELEMETRY_ENDPOINTS.platform,
      qualityPath,
      {},
      this.debug
    );

    // 2. Fetch ad phrases (iflow.cn)
    sendHttpGet(
      TELEMETRY_ENDPOINTS.iflow,
      TELEMETRY_PATHS.adPhrases,
      {
        'User-Agent': IFLOW_CLI_USER_AGENT,
        'Content-Type': 'application/json',
      },
      this.debug
    );

    if (this.debug) {
      console.log('[IFlowTransformer] Startup simulation sent (queryHighQuality + ad-phrases)');
    }
  }

  /**
   * Align official default parameters for request body
   */
  _alignOfficialBodyDefaults(requestBody, stream = false) {
    const body = { ...requestBody };

    // Streaming requests carry stream=true; non-streaming omit this field
    delete body.stream;
    if (stream) {
      body.stream = true;
    }

    // Official default parameters (from packet capture 2026-03-02)
    body.temperature = body.temperature ?? 1;
    body.top_p = body.top_p ?? 0.95;
    body.max_new_tokens = body.max_new_tokens ?? 32000;

    return body;
  }

  /**
   * Configure model-specific request parameters
   */
  _configureModelRequest(requestBody, model) {
    const body = { ...requestBody };
    const modelLower = model.toLowerCase();

    // DeepSeek models
    if (modelLower.startsWith('deepseek')) {
      if (body.thinking_mode === undefined) {
        body.thinking_mode = true;
      }
      if (body.reasoning === undefined) {
        body.reasoning = true;
      }
    }
    // GLM-5 model
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
    }
    // GLM-4.7 model
    else if (model === 'glm-4.7') {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    }
    // Other GLM models
    else if (modelLower.startsWith('glm-')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    }
    // Kimi-K2.5 model
    else if (modelLower.startsWith('kimi-k2.5')) {
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
    }
    // Models containing "thinking"
    else if (modelLower.includes('thinking')) {
      if (body.thinking_mode === undefined) {
        body.thinking_mode = true;
      }
    }
    // mimo- models
    else if (modelLower.startsWith('mimo-')) {
      if (!body.thinking) {
        body.thinking = { type: 'enabled' };
      }
    }
    // Claude models
    else if (modelLower.includes('claude')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    }
    // sonnet- models
    else if (modelLower.includes('sonnet-')) {
      if (!body.chat_template_kwargs) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
    }
    // Models containing "reasoning"
    else if (modelLower.includes('reasoning')) {
      if (body.reasoning === undefined) {
        body.reasoning = true;
      }
    }

    // Qwen 4B models (do not support thinking)
    if (/^qwen.*4b/i.test(modelLower)) {
      delete body.thinking_mode;
      delete body.reasoning;
      delete body.chat_template_kwargs;
    }

    return body;
  }

  /**
   * Transform request - send telemetry, then transform with headers
   */
  async transformRequestIn(request, provider, context) {
    const timestamp = Date.now();
    // Handle both string and array api_key (for key rotation)
    const apiKeyRaw = provider.api_key || provider.apiKey;
    const apiKey = Array.isArray(apiKeyRaw)
      ? apiKeyRaw[Math.floor(Math.random() * apiKeyRaw.length)]
      : apiKeyRaw;

    // Simulate CLI startup requests on first use
    if (!this.startupSimulated) {
      this._simulateStartup(apiKey);
      this.startupSimulated = true;
    }

    // Derive deterministic userId and cna from apiKey
    const userId = deriveUserId(apiKey);
    const cna = deriveCna(apiKey);

    // Extract trace_id from existing traceparent or generate new
    const traceparent = context?.traceparent || generateTraceparent();
    const traceId = traceparent.split('-')[1] || crypto.randomBytes(16).toString('hex');

    // Build telemetry context
    const telemetryContext = {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      traceId,
      model: request.model || 'unknown',
      userId,
      cna,
    };

    // Send telemetry before AI request
    const trackingInfo = await this.sendRunStarted(telemetryContext);
    await this.sendAplusLog(telemetryContext);

    // Store tracking info in context for response phase
    if (context) {
      context._telemetryTracking = trackingInfo;
      context._telemetryContext = telemetryContext;
      context.traceparent = traceparent;
      context.sessionId = this.sessionId;
      context.conversationId = this.conversationId;
    }

    // Align body defaults
    let body = this._alignOfficialBodyDefaults(request, request.stream || false);

    // Configure model-specific parameters
    const model = body.model || '';
    body = this._configureModelRequest(body, model);

    // Build headers
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
      'traceparent': traceparent,
    };

    // Generate HMAC signature
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

    // Aone-specific headers
    if (isAoneEndpoint(provider.baseUrl)) {
      headers['X-Client-Type'] = 'iflow-cli';
      headers['X-Client-Version'] = IFLOW_CLI_VERSION;
    }

    if (this.debug) {
      console.log('[IFlowTransformer] Request transformed:');
      console.log(`  - Model: ${model}`);
      console.log(`  - Headers: ${Object.keys(headers).length}`);
      console.log(`  - Telemetry: sent run_started + APlus log`);
    }

    return {
      body,
      config: { headers },
    };
  }

  /**
   * Transform response - send run_finished after AI request completes
   */
  async transformResponseOut(response, context) {
    const trackingInfo = context?._telemetryTracking;
    const telemetryContext = context?._telemetryContext;

    if (trackingInfo && telemetryContext) {
      await this.sendRunFinished(telemetryContext, trackingInfo);

      if (this.debug) {
        console.log('[IFlowTransformer] Response: sent run_finished telemetry');
      }
    }

    return response;
  }

  /**
   * Reset session and conversation IDs
   */
  resetSession() {
    this.sessionId = `session-${uuidv4()}`;
    this.conversationId = uuidv4();

    if (this.debug) {
      console.log('[IFlowTransformer] Session reset:');
      console.log(`  - sessionId: ${this.sessionId}`);
      console.log(`  - conversationId: ${this.conversationId}`);
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      userId: this.userId,
      cna: this.cna,
      spmCnt: this.spmCnt,
      enableTelemetry: this.enableTelemetry,
    };
  }

  /**
   * Set user ID (for persistence)
   */
  setUserId(userId) {
    this.userId = userId;
    if (this.debug) {
      console.log(`[IFlowTransformer] Updated userId: ${userId}`);
    }
  }
};
