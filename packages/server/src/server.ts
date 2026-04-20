// @ts-ignore - requestStatsService is exported but not in type definitions
import Server, { calculateTokenCount, TokenizerService, requestStatsService, ConfigService, parseStatsKey } from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { CONFIG_FILE } from "@CCR/shared";
import { join } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync, watch, openSync, readSync, closeSync } from "fs";
import { stat } from "fs/promises";
import { homedir } from "os";
import { ProxyAgent } from "undici";
import {
  getPresetDir,
  readManifestFromDir,
  manifestToPresetFile,
  saveManifest,
  isPresetInstalled,
  extractPreset,
  HOME_DIR,
  extractMetadata,
  loadConfigFromManifest,
  downloadPresetToTemp,
  getTempDir,
  findMarketPresetByName,
  getMarketPresets,
  type PresetFile,
  type ManifestFile,
  type PresetMetadata,
} from "@CCR/shared";
import fastifyMultipart from "@fastify/multipart";
import AdmZip from "adm-zip";
import { batchTestService } from "./batch-test-service";
import { canonicalizeExternalConfig } from "@CCR/shared";
// requestStatsService and ConfigService are imported at the top level

// Helper functions to detect and handle compressed/garbled error responses
function isCompressedError(text: string): boolean {
  // Detect gzip compression magic number (0x1f8b) or other compression markers
  return text.charCodeAt(0) === 0x1F ||
         text.includes('\u001f') ||
         text.includes('\ufffd') ||
         (text.length > 0 && text.charCodeAt(0) === 31) ||
         // Also detect excessive non-printable characters which might indicate binary data
         (text.length > 0 && text.match(/[^\x20-\x7E\s]/g)?.length! > text.length * 0.3);
}

function replaceCompressedError(text: string, provider: string, model: string, status: number): any {
  // Return structured error object instead of garbled text
  const errorMsg = `模型 "${model}" (提供商: ${provider}) 返回了无法解析的错误；状态码: ${status}`;
  return {
    message: errorMsg,
    type: 'provider_error',
    code: 'invalid_response',
    status: status,
    detail: '可能是网络或编码问题，请检查模型配置或稍后重试',
    originalSize: text.length,
    note: '原始错误信息为压缩数据或二进制格式，无法显示',
    hint: '请确认该模型已被提供商正确配置并支持'
  };
}

export const createServer = async (config: any): Promise<any> => {
  const server = new Server(config);
  const app = server.app;

  // Track SSE clients for config broadcasting
  const sseClients = new Set<any>();
  let configWatcher: any = null;
  // Guard against self-triggered config watch events (internal writes from POST /api/config)
  let isInternalConfigWrite = false;
  let configWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Plugins directory watcher for hot-reload
  let pluginsWatcher: any = null;
  let pluginsWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const PLUGINS_DIR = join(homedir(), ".claude-code-router", "plugins");

  // Broadcast config change to all connected clients
  const broadcastConfigChange = (configData: any) => {
    const event = {
      type: 'config_update',
      data: configData,
      timestamp: Date.now()
    };
    sseClients.forEach(res => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (e) {
        // Client disconnected, remove from set
        sseClients.delete(res);
      }
    });
  };

  app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  app.post("/v1/messages/count_tokens", async (req: any, reply: any) => {
    const {messages, tools, system, model} = req.body;
    const tokenizerService = (app as any)._server!.tokenizerService as TokenizerService;

    // If model is specified in "providerName,modelName" format, use the configured tokenizer
    if (model && model.includes(",") && tokenizerService) {
      try {
        const [provider, modelName] = model.split(",");
        req.log?.info(`Looking up tokenizer for provider: ${provider}, model: ${modelName}`);

        const tokenizerConfig = tokenizerService.getTokenizerConfigForModel(provider, modelName);

        if (!tokenizerConfig) {
          req.log?.warn(`No tokenizer config found for ${provider},${modelName}, using default tiktoken`);
        } else {
          req.log?.info(`Using tokenizer config: ${JSON.stringify(tokenizerConfig)}`);
        }

        const result = await tokenizerService.countTokens(
          { messages, system, tools },
          tokenizerConfig
        );

        return {
          "input_tokens": result.tokenCount,
          "tokenizer": result.tokenizerUsed,
        };
      } catch (error: any) {
        req.log?.error(`Error using configured tokenizer: ${error.message}`);
        req.log?.error(error.stack);
        // Fall back to default calculation
      }
    } else {
      if (!model) {
        req.log?.info(`No model specified, using default tiktoken`);
      } else if (!model.includes(",")) {
        req.log?.info(`Model "${model}" does not contain comma, using default tiktoken`);
      } else if (!tokenizerService) {
        req.log?.warn(`TokenizerService not available, using default tiktoken`);
      }
    }

    // Default to tiktoken calculation
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Add endpoint to read config.json with access control
  app.get("/api/config", async (req: any, reply: any) => {
    return canonicalizeExternalConfig(await readConfigFile());
  });

  app.get("/api/transformers", async (req: any, reply: any) => {
    const transformers =
      (app as any)._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  app.post("/api/config", async (req: any, reply: any) => {
    const newConfig = canonicalizeExternalConfig(req.body);

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    // Detect removed transformers that point to plugins directory
    // and delete the corresponding plugin files
    try {
      const oldConfig = await readConfigFile();
      const oldTransformers = Array.isArray(oldConfig.transformers) ? oldConfig.transformers : [];
      const newTransformers = Array.isArray(newConfig.transformers) ? newConfig.transformers : [];

      // Find transformers that were removed
      const oldPaths = new Set<string>(oldTransformers.map((t: any) => t.path).filter(Boolean) as string[]);
      const newPaths = new Set<string>(newTransformers.map((t: any) => t.path).filter(Boolean) as string[]);

      for (const oldPath of oldPaths) {
        if (!newPaths.has(oldPath) && oldPath.startsWith(PLUGINS_DIR)) {
          // This transformer was removed and points to plugins directory
          // Delete the plugin file
          if (existsSync(oldPath)) {
            console.log(`Deleting plugin file (removed from config): ${oldPath}`);
            unlinkSync(oldPath);
          }
        }
      }
    } catch (err) {
      console.error('Error detecting removed transformers:', err);
    }

    // Add lastModified timestamp
    const configWithTimestamp = {
      ...newConfig,
      _lastModified: Date.now()
    };

    // Mark as internal write to prevent config watcher from re-triggering
    isInternalConfigWrite = true;
    await writeConfigFile(configWithTimestamp);
    // Reset flag after fs.watch has had time to fire (500ms buffer)
    setTimeout(() => { isInternalConfigWrite = false; }, 500);

    // Actively trigger hot-reload after writing config
    // (fs.watch is intentionally skipped for internal writes to prevent loops,
    //  so we must reload services directly here)
    try {
      const configService = (app as any)._server?.configService as ConfigService;
      if (configService) {
        const result = await configService.reloadWithValidation();
        if (result.valid && result.config) {
          broadcastConfigChange(result.config);
        }
      }
    } catch (err) {
      console.error('Error during post-save hot-reload:', err);
    }

    return { success: true, message: "Config saved successfully", lastModified: configWithTimestamp._lastModified };
  });

  /**
   * Process transformer result, extracting body and config if present
   * Handles both simple return (body only) and structured return (body + config)
   */
  function processTransformerResult(
    result: any,
    currentBody: any,
    currentConfig: any
  ): { body: any; config: any } {
    // Check if result has structure { body: ..., config: ... }
    if (result && typeof result === 'object' && result.body) {
      // Structured return - extract body and merge config
      const newConfig = { ...currentConfig };
      if (result.config) {
        newConfig.headers = {
          ...(currentConfig.headers || {}),
          ...(result.config.headers || {})
        };
        if (result.config.url) {
          newConfig.url = result.config.url;
        }
      }
      return { body: result.body, config: newConfig };
    }
    // Simple return - just update body
    return { body: result, config: currentConfig };
  }

  /**
   * Build request headers, merging transformer headers with default authentication
   * Cleans up headers with 'undefined' values
   */
  function buildRequestHeaders(
    apiKey: string,
    transformerHeaders: Record<string, string | undefined> = {}
  ): Record<string, string> {
    const headers: Record<string, string | undefined> = {
      "Content-Type": "application/json",
    };

    // Only add default Authorization if transformer didn't set x-api-key
    // and didn't explicitly set authorization to undefined
    const hasXApiKey = transformerHeaders["x-api-key"] || transformerHeaders["X-API-Key"];
    const authExplicitlyRemoved = ("authorization" in transformerHeaders && transformerHeaders.authorization === undefined)
                               || ("Authorization" in transformerHeaders && transformerHeaders.Authorization === undefined);

    if (!hasXApiKey && !authExplicitlyRemoved) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // Merge transformer headers
    for (const [key, value] of Object.entries(transformerHeaders)) {
      if (value !== undefined && value !== "undefined") {
        headers[key] = value;
      }
    }

    // Clean up headers with 'undefined' values or containing "undefined"
    for (const key in headers) {
      if (headers[key] === "undefined" || headers[key] === undefined ||
          (["authorization", "Authorization"].includes(key) && headers[key]?.includes("undefined"))) {
        delete headers[key];
      }
    }

    return headers as Record<string, string>;
  }

  /**
   * Extract response content from various response formats
   * Supports: OpenAI format, Anthropic format, and generic formats
   */
  function extractResponseContent(data: any): string {
    // OpenAI format: choices[0].message.content
    // Use typeof check to handle empty string correctly (empty string is falsy)
    const message = data.choices?.[0]?.message;
    if (message) {
      if (typeof message.content === 'string' && message.content) {
        return message.content;
      }
      // Fallback: reasoning_content for reasoning models (e.g. GLM, DeepSeek)
      // When content is empty due to token exhaustion, reasoning_content may still have useful output
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        return message.reasoning_content;
      }
    }

    // Anthropic format: find first text block in content array
    // Extended thinking responses have content[0] as thinking block, text is in a later block
    if (Array.isArray(data.content)) {
      const textBlock = data.content.find((block: any) => block.type === 'text' && block.text);
      if (textBlock) {
        return textBlock.text;
      }
      // Fallback: first block with text property (non-typed responses)
      const anyTextBlock = data.content.find((block: any) => typeof block.text === 'string' && block.text);
      if (anyTextBlock) {
        return anyTextBlock.text;
      }
    }

    // Direct content field
    if (typeof data.content === 'string') {
      return data.content;
    }

    // Generic text field
    if (typeof data.text === 'string') {
      return data.text;
    }

    // Nested message content
    if (data.message && typeof data.message.content === 'string') {
      return data.message.content;
    }

    // Return empty string if no format matches
    return '';
  }

  /**
   * Execute a single model test, reusable by both the API route and BatchTestService.
   * Returns a result object without touching reply - caller handles HTTP response.
   * Accepts an optional AbortSignal for external cancellation (e.g. batch test cancel).
   */
  async function executeModelTest(
    provider: string,
    model: string,
    message?: string,
    externalSignal?: AbortSignal,
    specificKeyIndex?: number
  ): Promise<{ success: boolean; status?: number; response?: string; error?: string; rawResponse?: any; debug?: any; keyIndex?: number }> {
    let providerData: any;
    let processedRequest: any;
    let requestConfig: any = {};
    let selectedKeyIndex: number = 0;

    const serverInstance = (app as any)._server;
    const providerService = serverInstance?.providerService;

    if (!providerService) {
      return { success: false, error: "Service is initializing, please try again later" };
    }

    providerData = providerService.getProvider(provider);
    if (!providerData) {
      // Reload config and retry once
      providerService.reload();
      providerData = providerService.getProvider(provider);
      if (!providerData) {
        return { success: false, error: `Provider '${provider}' not found` };
      }
    }

    // Model name validation removed: if the model name is wrong,
    // the upstream API will return its own error message.

    try {
      // Construct test request
      const configService = serverInstance.configService;
      const testMessage = message || configService.get("TEST_PROMPT") || "Hello, please respond with 'OK' if you can understand this message.";
      const requestBody = {
        model: model,
        messages: [{ role: "user", content: testMessage }],
        max_tokens: 300,
        stream: false
      };

      // Apply provider transformers if configured
      processedRequest = requestBody;
      requestConfig = {};

      if (providerData.transformer?.use) {
        for (const transformer of providerData.transformer.use) {
          if (transformer && typeof transformer.transformRequestIn === "function") {
            const transformResult = await transformer.transformRequestIn(processedRequest, providerData, {});
            const { body, config } = processTransformerResult(transformResult, processedRequest, requestConfig);
            processedRequest = body;
            requestConfig = config;
          }
        }
      }

      // Apply model-specific transformers if configured
      if (providerData.transformer?.[model]?.use) {
        for (const transformer of providerData.transformer[model].use) {
          if (transformer && typeof transformer.transformRequestIn === "function") {
            const transformResult = await transformer.transformRequestIn(processedRequest, providerData, {});
            const { body, config } = processTransformerResult(transformResult, processedRequest, requestConfig);
            processedRequest = body;
            requestConfig = config;
          }
        }
      }

      // Apply auth method from transformers (use resolvedProvider for transformer compat)
      // Resolve API key - use specific key if provided, otherwise round-robin
      let selectedApiKey: string;
      if (specificKeyIndex !== undefined && Array.isArray(providerData.apiKey)) {
        // Direct key selection by index
        const entry = providerData.apiKey[specificKeyIndex];
        selectedApiKey = typeof entry === 'string' ? entry : (entry?.key || '');
        selectedKeyIndex = specificKeyIndex;
      } else {
        const resolvedKey = providerService.getApiKey(
          providerData.name,
          providerData.apiKey,
          model,
          providerData.models
        );
        selectedApiKey = resolvedKey.key;
        selectedKeyIndex = resolvedKey.keyIndex;
      }
      const resolvedProviderData = { ...providerData, apiKey: selectedApiKey };

      for (const transformer of providerData.transformer?.use || []) {
        if (transformer && typeof transformer.auth === "function") {
          const authResult = await transformer.auth(processedRequest, resolvedProviderData, {});
          if (authResult?.body) {
            const { body, config } = processTransformerResult(authResult, processedRequest, requestConfig);
            processedRequest = body;
            if (config?.headers) {
              requestConfig.headers = { ...(requestConfig.headers || {}), ...config.headers };
            }
          }
        }
      }

      for (const transformer of providerData.transformer?.[model]?.use || []) {
        if (transformer && typeof transformer.auth === "function") {
          const authResult = await transformer.auth(processedRequest, resolvedProviderData, {});
          if (authResult?.body) {
            const { body, config } = processTransformerResult(authResult, processedRequest, requestConfig);
            processedRequest = body;
            if (config?.headers) {
              requestConfig.headers = { ...(requestConfig.headers || {}), ...config.headers };
            }
          }
        }
      }

      // Build target URL with transformer endPoint support
      let targetUrl = requestConfig.url || providerData.baseUrl;

      if (!requestConfig.url && providerData.transformer?.use) {
        for (const transformer of providerData.transformer.use) {
          if (transformer && transformer.endPoint) {
            const baseUrl = targetUrl.replace(/\/$/, '');
            const endPoint = transformer.endPoint.replace(/^\//, '');
            targetUrl = `${baseUrl}/${endPoint}`;
            break;
          }
        }
      }

      if (!requestConfig.url && providerData.transformer?.[model]?.use) {
        for (const transformer of providerData.transformer[model].use) {
          if (transformer && transformer.endPoint) {
            const baseUrl = targetUrl.replace(/\/$/, '');
            const endPoint = transformer.endPoint.replace(/^\//, '');
            targetUrl = `${baseUrl}/${endPoint}`;
            break;
          }
        }
      }

      // Build request headers with the already-resolved API key
      const requestHeaders = buildRequestHeaders(selectedApiKey, requestConfig.headers || {});

      // Create AbortController for timeout, link with external signal
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      // If external signal is already aborted, abort immediately
      if (externalSignal?.aborted) {
        clearTimeout(timeout);
        return { success: false, status: 499, error: "Cancelled" };
      }

      // Listen for external abort
      const onExternalAbort = () => controller.abort();
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

      const fetchOptions: RequestInit = {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(processedRequest),
        signal: controller.signal
      };

      const configService2 = serverInstance.configService;
      const httpsProxy = configService2.getHttpsProxy();
      if (httpsProxy) {
        (fetchOptions as any).dispatcher = new ProxyAgent(httpsProxy);
      }

      const response = await fetch(targetUrl, fetchOptions);
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);

      if (response.ok) {
        const data = await response.json();
        let responseText = extractResponseContent(data);
        const trimmedResponse = responseText.trim();

        if (!trimmedResponse) {
          const errorMessage = `Model returned empty response. Raw response: ${JSON.stringify(data)}`;
          requestStatsService.recordFailure(provider, model, processedRequest, errorMessage, 200);
          requestStatsService.recordKeyFailure(provider, selectedKeyIndex, model, processedRequest, errorMessage, 200);
          return {
            success: false,
            error: "Model returned empty response",
            rawResponse: data,
            debug: {
              message: "Response extraction failed or content was empty",
              responseStructure: Object.keys(data),
              extractedText: responseText
            }
          };
        }

        requestStatsService.recordSuccess(provider, model, processedRequest, data);
        requestStatsService.recordKeySuccess(provider, selectedKeyIndex, model, processedRequest, data);
        return { success: true, status: response.status, response: responseText, keyIndex: selectedKeyIndex };
      } else {
        const errorText = await response.text();
        let errorData: any = errorText;

        if (isCompressedError(errorText)) {
          errorData = replaceCompressedError(errorText, provider, model, response.status);
        } else {
          try { errorData = JSON.parse(errorText); } catch (e) { /* keep as is */ }
        }

        requestStatsService.recordFailure(provider, model, processedRequest, errorText, response.status);
        requestStatsService.recordKeyFailure(provider, selectedKeyIndex, model, processedRequest, errorText, response.status);
        return { success: false, status: response.status, error: errorData };
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Distinguish between timeout and external cancellation
        if (externalSignal?.aborted) {
          return { success: false, status: 499, error: "Cancelled" };
        }
        requestStatsService.recordFailure(provider, model, processedRequest || {}, "Request timeout (20 seconds)", 504);
        requestStatsService.recordKeyFailure(provider, selectedKeyIndex, model, processedRequest || {}, "Request timeout (20 seconds)", 504);
        return { success: false, status: 504, error: "Request timeout (20 seconds)" };
      }

      const targetUrl = requestConfig?.url || providerData?.baseUrl || 'unknown';
      let errorDetail = `Failed to connect to provider API at ${targetUrl}`;
      if (error.cause) errorDetail += `\nCause: ${error.cause}`;
      if (error.code) errorDetail += `\nError code: ${error.code}`;
      errorDetail += `\nOriginal error: ${error.message || 'Unknown error'}`;

      requestStatsService.recordFailure(provider, model, processedRequest || {}, errorDetail, 500);
      requestStatsService.recordKeyFailure(provider, selectedKeyIndex, model, processedRequest || {}, errorDetail, 500);
      return { success: false, status: 500, error: errorDetail };
    }
  }

  // Expose executeModelTest for BatchTestService
  (app as any).executeModelTest = executeModelTest;

  // Add endpoint to test a specific provider+model (delegates to executeModelTest)
  app.post("/api/model-test", async (req: any, reply: any) => {
    const { provider, model, message, keyIndex } = req.body;

    if (!provider || !model) {
      reply.status(400).send({ success: false, error: "provider and model are required" });
      return;
    }

    const result = await executeModelTest(provider, model, message, undefined, keyIndex);

    // Always return 200 to avoid triggering frontend auth redirect
    reply.status(200).send(result);
  });

  // Add endpoint to test provider URL connectivity (HEAD request with fallback to GET)
  app.post("/api/connectivity-test", async (req: any, reply: any) => {
    const { url } = req.body as { url?: string };

    if (!url) {
      reply.status(400).send({ success: false, error: "url is required" });
      return;
    }

    // Extract base domain URL (protocol + hostname + port)
    let baseUrl: string;
    try {
      const urlObj = new URL(url);
      baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
    } catch {
      reply.status(400).send({ success: false, error: "Invalid URL format" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const startTime = Date.now();

    try {
      const fetchOptions: RequestInit = {
        method: "HEAD",
        signal: controller.signal,
      };

      // Use proxy if configured
      const serverInst = (app as any)._server;
      const configService2 = serverInst?.configService;
      const httpsProxy = configService2?.getHttpsProxy();
      if (httpsProxy) {
        (fetchOptions as any).dispatcher = new ProxyAgent(httpsProxy);
      }

      let response: Response;
      try {
        response = await fetch(baseUrl, fetchOptions);
      } catch {
        // HEAD might be rejected, fallback to GET
        fetchOptions.method = "GET";
        response = await fetch(baseUrl, fetchOptions);
      }

      clearTimeout(timeout);
      const latency = Date.now() - startTime;

      reply.status(200).send({
        success: true,
        latency_ms: latency,
        status: response.status,
      });
    } catch (error: any) {
      clearTimeout(timeout);
      const latency = Date.now() - startTime;

      if (error.name === "AbortError") {
        reply.status(200).send({
          success: false,
          latency_ms: latency,
          error: "Connection timeout (10 seconds)",
        });
        return;
      }

      reply.status(200).send({
        success: false,
        latency_ms: latency,
        error: error.message || "Connection failed",
      });
    }
  });

  // Proxy endpoint for fetching models from provider's /v1/models endpoint
  // This avoids CORS issues when the UI fetches directly from external providers
  app.post("/api/fetch-models", async (req: any, reply: any) => {
    const { api_base_url, api_key, forceStandard } = req.body as { api_base_url?: string; api_key?: string; forceStandard?: boolean };

    if (!api_base_url) {
      reply.status(400).send({ success: false, error: "api_base_url is required" });
      return;
    }

    // Extract base URL (strip /v1/... suffix)
    let baseUrl = api_base_url.replace(/\/$/, '');
    baseUrl = baseUrl.replace(/\/v1\/?.*$/, '');

    // Get proxy config
    const serverInst = (app as any)._server;
    const configService2 = serverInst?.configService;
    const httpsProxy = configService2?.getHttpsProxy();

    // Step 1: Try NewAPI detection via /api/pricing (no auth, 3s timeout)
    let newApiData: any = null;
    if (!forceStandard) {
    try {
      const pricingController = new AbortController();
      const pricingTimeout = setTimeout(() => pricingController.abort(), 3000);

      const fetchOptions: RequestInit = {
        method: 'GET',
        signal: pricingController.signal,
      };
      if (httpsProxy) {
        (fetchOptions as any).dispatcher = new ProxyAgent(httpsProxy);
      }

      const pricingResponse = await fetch(`${baseUrl}/api/pricing`, fetchOptions);
      clearTimeout(pricingTimeout);

      if (pricingResponse.ok) {
        const data = await pricingResponse.json();
        if (data.success === true && data.group_ratio && Array.isArray(data.data)) {
          newApiData = data;
        }
      }
    } catch {
      // Not NewAPI or unreachable, continue to /v1/models
    }

    if (newApiData) {
      reply.status(200).send({ success: true, type: 'newapi', data: newApiData });
      return;
    }
    }

    // Step 2: Standard /v1/models fetch (api_key optional — some public endpoints don't require auth)
    try {
      const modelsController = new AbortController();
      const modelsTimeout = setTimeout(() => modelsController.abort(), 10000);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (api_key) {
        headers['Authorization'] = `Bearer ${api_key}`;
      }

      const fetchOptions: RequestInit = {
        method: 'GET',
        headers,
        signal: modelsController.signal,
      };
      if (httpsProxy) {
        (fetchOptions as any).dispatcher = new ProxyAgent(httpsProxy);
      }

      const response = await fetch(`${baseUrl}/v1/models`, fetchOptions);
      clearTimeout(modelsTimeout);

      if (!response.ok) {
        let errorDetail = response.statusText;
        try {
          const errorBody = await response.text();
          if (errorBody) errorDetail = `${response.status} - ${errorBody}`;
        } catch {}
        reply.status(200).send({ success: false, error: `HTTP ${response.status}: ${errorDetail}` });
        return;
      }

      const data = await response.json();
      reply.status(200).send({ success: true, type: 'models', data });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        reply.status(200).send({ success: false, error: 'Connection timeout (10 seconds)' });
        return;
      }
      reply.status(200).send({ success: false, error: error.message || 'Failed to fetch models' });
    }
  });

  // Register static file serving with caching
  app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  app.get("/ui", async (_: any, reply: any) => {
    return reply.redirect("/ui/");
  });

  // SSE log streaming endpoint
  app.get("/api/logs/stream", async (req: any, reply: any) => {
    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");

    const logDir = join(homedir(), ".claude-code-router", "logs");
    let currentLogFile = "";
    let fileWatcher: any = null;
    let dirWatcher: any = null;
    let lastSize = 0;
    let isClosed = false;

    // Helper to find latest log file
    const findLatestLog = () => {
      if (!existsSync(logDir)) return null;
      const files = readdirSync(logDir)
        .filter(f => f.startsWith("ccr-") && f.endsWith(".log"))
        .sort()
        .reverse();
      return files.length > 0 ? join(logDir, files[0]) : null;
    };

    // Helper to setup file watcher on specific file
    const setupFileWatcher = (filePath: string, controller: any) => {
      if (fileWatcher) fileWatcher.close();

      try {
        const stats = statSync(filePath);
        lastSize = stats.size;
        currentLogFile = filePath;

        // Notify client about file switch
        controller.enqueue(`data: ${JSON.stringify({
          type: 'system',
          msg: `Watching log file: ${filePath.split('/').pop()}`
        })}\n\n`);

        fileWatcher = watch(filePath, { persistent: true }, (eventType) => {
          if (eventType === 'change' && !isClosed && existsSync(filePath)) {
            try {
              const currentStats = statSync(filePath);
              if (currentStats.size > lastSize) {
                const fd = openSync(filePath, 'r');
                const buffer = Buffer.alloc(currentStats.size - lastSize);
                readSync(fd, buffer, 0, buffer.length, lastSize);
                closeSync(fd);

                const newContent = buffer.toString('utf8');
                lastSize = currentStats.size;

                const lines = newContent.split('\n');
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const data = JSON.parse(line);
                    // Only send routing logs (skip request body logs)
                    if (data.type === 'routing' && data.targetModel) {
                      // Translate scenarioType to Chinese label
                      const scenarioType = data.scenarioType as string;
                      const scenarioLabel: Record<string, string> = {
                        'background': '后台任务',
                        'default': '普通任务',
                        'longContext': '长上下文',
                        'think': '思考任务',
                        'webSearch': '搜索任务',
                        'compact': '压缩任务',
                        'image': '图片任务'
                      };
                      const label = scenarioLabel[scenarioType] || '普通任务';

                      const event = {
                        type: 'log',
                        data: {
                          id: `${data.reqId}-${data.time}`,
                          timestamp: new Date(data.time).toLocaleTimeString(),
                          reqId: data.reqId,
                          model: data.targetModel,
                          scenarioType: scenarioType,
                          scenarioLabel: label,
                          msg: data.msg,
                          raw: line
                        }
                      };
                      controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
                    }

                    // Handle request completion logs for monitor panel status
                    if (data.type === 'request_complete') {
                      const event = {
                        type: 'request_complete',
                        data: {
                          reqId: data.reqId,
                          provider: data.provider,
                          model: data.model,
                          success: data.success,
                          statusCode: data.statusCode,
                          error: data.error,
                        }
                      };
                      controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
                    }
                  } catch (e) {
                    // Ignore parse errors
                  }
                }
              }
            } catch (err) {
              console.error('Error reading log update:', err);
            }
          }
        });
      } catch (err) {
        console.error('Error setting up file watcher:', err);
      }
    };

    const sseStream = new ReadableStream({
      start(controller) {
        const initialFile = findLatestLog();
        if (initialFile) {
          setupFileWatcher(initialFile, controller);
        } else {
          controller.enqueue(`data: ${JSON.stringify({ type: 'system', msg: 'No log files found' })}\n\n`);
        }

        // Watch directory for rotation (new files)
        try {
          if (existsSync(logDir)) {
            dirWatcher = watch(logDir, { persistent: true }, (eventType, filename) => {
              if (filename && filename.startsWith("ccr-") && filename.endsWith(".log")) {
                const latest = findLatestLog();
                if (latest && latest !== currentLogFile) {
                  setupFileWatcher(latest, controller);
                }
              }
            });
          }
        } catch (err) {
          console.error('Error watching log directory:', err);
        }

        // Cleanup on close
        req.raw.on('close', () => {
          isClosed = true;
          if (fileWatcher) fileWatcher.close();
          if (dirWatcher) dirWatcher.close();
          try { controller.close(); } catch (e) {}
        });

        req.raw.on('error', () => {
          isClosed = true;
          if (fileWatcher) fileWatcher.close();
          if (dirWatcher) dirWatcher.close();
          try { controller.close(); } catch (e) {}
        });
      }
    });

    // Pipe stream to response
    const reader = sseStream.getReader();
    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) {
          reply.raw.end();
          return;
        }
        reply.raw.write(value);
        pump();
      }).catch(() => {
        reply.raw.end();
      });
    };
    pump();
  });

  // Get log file list endpoint
  app.get("/api/logs/files", async (req: any, reply: any) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // Sort by modification time in descending order
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // Get log content endpoint
  app.get("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // Clear log content endpoint
  app.delete("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  // Clear all logs endpoint
  app.delete("/api/logs/all", async (req: any, reply: any) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);
        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            try {
              // Delete the file
              unlinkSync(filePath);
            } catch (err) {
              console.error(`Failed to delete log file ${file}:`, err);
            }
          }
        }
      }

      return { success: true, message: "All logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear all logs:", error);
      reply.status(500).send({ error: "Failed to clear all logs" });
    }
  });

  // Get presets list
  app.get("/api/presets", async (req: any, reply: any) => {
    try {
      const presetsDir = join(HOME_DIR, "presets");

      if (!existsSync(presetsDir)) {
        return { presets: [] };
      }

      const entries = readdirSync(presetsDir, { withFileTypes: true });
      const presetDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

      const presets: Array<PresetMetadata & { installed: boolean; id: string }> = [];

      for (const dirName of presetDirs) {
        const presetDir = join(presetsDir, dirName);
        try {
          const manifestPath = join(presetDir, "manifest.json");
          const content = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);

          // Extract metadata fields
          const { Providers, Router, PORT, HOST, API_TIMEOUT_MS, PROXY_URL, LOG, LOG_LEVEL, StatusLine, NON_INTERACTIVE_MODE, ...metadata } = manifest;

          presets.push({
            id: dirName,  // Use directory name as unique identifier
            name: metadata.name || dirName,
            version: metadata.version || '1.0.0',
            description: metadata.description,
            author: metadata.author,
            homepage: metadata.homepage,
            repository: metadata.repository,
            license: metadata.license,
            keywords: metadata.keywords,
            ccrVersion: metadata.ccrVersion,
            source: metadata.source,
            sourceType: metadata.sourceType,
            checksum: metadata.checksum,
            installed: true,
          });
        } catch (error) {
          console.error(`Failed to read preset ${dirName}:`, error);
        }
      }

      return { presets };
    } catch (error) {
      console.error("Failed to get presets:", error);
      reply.status(500).send({ error: "Failed to get presets" });
    }
  });

  // Get preset details
  app.get("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      const manifest = await readManifestFromDir(presetDir);
      const presetFile = manifestToPresetFile(manifest);

      // Return preset info, config uses the applied userValues configuration
      return {
        ...presetFile,
        config: loadConfigFromManifest(manifest, presetDir),
        userValues: manifest.userValues || {},
      };
    } catch (error: any) {
      console.error("Failed to get preset:", error);
      reply.status(500).send({ error: error.message || "Failed to get preset" });
    }
  });

  // Apply preset (configure sensitive information)
  app.post("/api/presets/:name/apply", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const { secrets } = req.body;

      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Read existing manifest
      const manifest = await readManifestFromDir(presetDir);

      // Save user input to userValues (keep original config unchanged)
      const updatedManifest: ManifestFile = { ...manifest };

      // Save or update userValues
      if (secrets && Object.keys(secrets).length > 0) {
        updatedManifest.userValues = {
          ...updatedManifest.userValues,
          ...secrets,
        };
      }

      // Save updated manifest
      await saveManifest(name, updatedManifest);

      return { success: true, message: "Preset applied successfully" };
    } catch (error: any) {
      console.error("Failed to apply preset:", error);
      reply.status(500).send({ error: error.message || "Failed to apply preset" });
    }
  });

  // Delete preset
  app.delete("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Recursively delete entire directory
      rmSync(presetDir, { recursive: true, force: true });

      return { success: true, message: "Preset deleted successfully" };
    } catch (error: any) {
      console.error("Failed to delete preset:", error);
      reply.status(500).send({ error: error.message || "Failed to delete preset" });
    }
  });

  // Get preset market list
  app.get("/api/presets/market", async (req: any, reply: any) => {
    try {
      // Use market presets function
      const marketPresets = await getMarketPresets();
      return { presets: marketPresets };
    } catch (error: any) {
      console.error("Failed to get market presets:", error);
      reply.status(500).send({ error: error.message || "Failed to get market presets" });
    }
  });

  // Install preset from GitHub repository by preset name
  app.post("/api/presets/install/github", async (req: any, reply: any) => {
    try {
      const { presetName } = req.body;

      if (!presetName) {
        reply.status(400).send({ error: "Preset name is required" });
        return;
      }

      // Check if preset is in the marketplace
      const marketPreset = await findMarketPresetByName(presetName);
      if (!marketPreset) {
        reply.status(400).send({
          error: "Preset not found in marketplace",
          message: `Preset '${presetName}' is not available in the official marketplace. Please check the available presets.`
        });
        return;
      }

      // Get repository from market preset
      if (!marketPreset.repo) {
        reply.status(400).send({
          error: "Invalid preset data",
          message: `Preset '${presetName}' does not have repository information`
        });
        return;
      }

      // Parse GitHub repository URL
      const githubRepoMatch = marketPreset.repo.match(/(?:github\.com[:/]|^)([^/]+)\/([^/\s#]+?)(?:\.git)?$/);
      if (!githubRepoMatch) {
        reply.status(400).send({ error: "Invalid GitHub repository URL" });
        return;
      }

      const [, owner, repoName] = githubRepoMatch;

      // Use preset name from market
      const installedPresetName = marketPreset.name || presetName;

      // Check if already installed BEFORE downloading
      if (await isPresetInstalled(installedPresetName)) {
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' is already installed. To update or reconfigure, please delete it first using the delete button.`,
          presetName: installedPresetName
        });
        return;
      }

      // Download GitHub repository ZIP file
      const downloadUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
      const tempFile = await downloadPresetToTemp(downloadUrl);

      // Load preset to validate structure
      const preset = await loadPresetFromZip(tempFile);

      // Double-check if already installed (in case of race condition)
      if (await isPresetInstalled(installedPresetName)) {
        unlinkSync(tempFile);
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' was installed while downloading. Please try again.`,
          presetName: installedPresetName
        });
        return;
      }

      // Extract to target directory
      const targetDir = getPresetDir(installedPresetName);
      await extractPreset(tempFile, targetDir);

      // Read manifest and add repo information
      const manifest = await readManifestFromDir(targetDir);

      // Add repo information to manifest from market data
      manifest.repository = marketPreset.repo;
      if (marketPreset.url) {
        manifest.source = marketPreset.url;
      }

      // Save updated manifest
      await saveManifest(installedPresetName, manifest);

      // Clean up temp file
      unlinkSync(tempFile);

      return {
        success: true,
        presetName: installedPresetName,
        preset: {
          ...preset.metadata,
          installed: true,
        }
      };
    } catch (error: any) {
      console.error("Failed to install preset from GitHub:", error);
      reply.status(500).send({ error: error.message || "Failed to install preset from GitHub" });
    }
  });

  // Helper function: Load preset from ZIP
  async function loadPresetFromZip(zipFile: string): Promise<PresetFile> {
    const zip = new AdmZip(zipFile);

    // First try to find manifest.json in root directory
    let entry = zip.getEntry('manifest.json');

    // If not in root, try to find in subdirectories (handle GitHub repo archive structure)
    if (!entry) {
      const entries = zip.getEntries();
      // Find any manifest.json file
      entry = entries.find(e => e.entryName.includes('manifest.json')) || null;
    }

    if (!entry) {
      throw new Error('Invalid preset file: manifest.json not found');
    }

    const manifest = JSON.parse(entry.getData().toString('utf-8')) as ManifestFile;
    return manifestToPresetFile(manifest);
  }

  // SSE config streaming endpoint
  app.get("/api/config/stream", async (req: any, reply: any) => {
    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    const res = reply.raw;
    let heartbeatInterval: NodeJS.Timeout | null = null;

    // Send data function
    const send = (data: string) => {
      try {
        res.write(data);
      } catch (e) {
        // Client disconnected, cleanup
        cleanup();
      }
    };

    // Cleanup function
    const cleanup = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      sseClients.delete(res);
      try {
        res.end();
      } catch (e) {}
    };

    // Add client to broadcast set
    sseClients.add(res);

    // Handle connection close
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Start the response
    reply.raw.writeHead(200);

    // Send current config immediately
    readConfigFile().then(currentConfig => {
      send(`data: ${JSON.stringify({
        type: 'config_update',
        data: currentConfig,
        timestamp: Date.now()
      })}\n\n`);
    }).catch(err => {
      console.error('Error reading config for SSE:', err);
    });

    // Send heartbeat every 30 seconds to keep connection alive
    heartbeatInterval = setInterval(() => {
      send(': heartbeat\n\n');
    }, 30000);

    // Return a promise that never resolves to keep the connection open
    return new Promise(() => {});
  });

  // SSE restart status endpoint
  app.get("/api/restart/status", async (req: any, reply: any) => {
    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const res = reply.raw;

    // Send restart preparing status
    res.write(`data: ${JSON.stringify({ type: 'restart_preparing', timestamp: Date.now() })}\n\n`);

    // Wait 1 second then send service stopping
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ type: 'service_stopping', timestamp: Date.now() })}\n\n`);
      res.end();
    }, 1000);

    // Handle connection close
    req.raw.on('close', () => {
      try { res.end(); } catch (e) {}
    });

    return new Promise(() => {});
  });

  // Get request stats
  app.get("/api/request-stats", async (req: any, reply: any) => {
    try {
      // requestStatsService is imported at the top level
      const allStats = requestStatsService.getAllStats() as Map<string, any>;
      const statsArray: Array<{ key: string; provider: string; model: string; keyIndex?: number; success: number; fail: number; lastRequest?: any }> = [];
      allStats.forEach((value: any, key: string) => {
        const parsed = parseStatsKey(key);
        statsArray.push({
          key,
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.keyIndex !== undefined ? { keyIndex: parsed.keyIndex } : {}),
          ...value
        });
      });
      return { stats: statsArray };
    } catch (error) {
      console.error("Failed to get request stats:", error);
      reply.status(500).send({ error: "Failed to get request stats" });
    }
  });

  // Request stats SSE stream
  app.get("/api/request-stats/stream", async (req: any, reply: any) => {
    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    const res = reply.raw;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    let statsListener: any = null;
    let clearListener: any = null;
    // requestStatsService is imported at the top level

    // Send data function
    const send = (data: string) => {
      try {
        res.write(data);
      } catch (e) {
        cleanup();
      }
    };

    // Cleanup function
    const cleanup = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (statsListener) requestStatsService.off('stats_update', statsListener);
      if (clearListener) requestStatsService.off('stats_clear', clearListener);
      try { res.end(); } catch (e) {}
    };

    // Handle connection close
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Start response
    reply.raw.writeHead(200);

    // Send initial stats
    const allStats = requestStatsService.getAllStats() as Map<string, any>;
    const initialStats: Array<{ key: string; provider: string; model: string; keyIndex?: number; success: number; fail: number; lastRequest?: any }> = [];
    allStats.forEach((value: any, key: string) => {
      const parsed = parseStatsKey(key);
      initialStats.push({
        key,
        provider: parsed.provider,
        model: parsed.model,
        ...(parsed.keyIndex !== undefined ? { keyIndex: parsed.keyIndex } : {}),
        ...value
      });
    });

    send(`data: ${JSON.stringify({
      type: 'initial',
      data: initialStats,
      timestamp: Date.now()
    })}\n\n`);

    // Listen for updates
    statsListener = (update: any) => {
      const parsed = parseStatsKey(update.key);
      const data = {
        type: 'update',
        data: {
          key: update.key,
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.keyIndex !== undefined ? { keyIndex: parsed.keyIndex } : {}),
          ...update.stats
        },
        timestamp: Date.now()
      };
      console.log('[SSE] Sending stats update:', JSON.stringify(data, null, 2));
      send(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Listen for clear events
    clearListener = () => {
      send(`data: ${JSON.stringify({
        type: 'clear',
        timestamp: Date.now()
      })}\n\n`);
    };

    requestStatsService.on('stats_update', statsListener);
    requestStatsService.on('stats_clear', clearListener);

    // Heartbeat every 30s
    heartbeatInterval = setInterval(() => {
      send(': heartbeat\n\n');
    }, 30000);

    return new Promise(() => {});
  });

  // Clear request stats
  app.delete("/api/request-stats", async (req: any, reply: any) => {
    try {
      // requestStatsService is imported at the top level
      requestStatsService.clearAll();
      return { success: true, message: "Request stats cleared successfully" };
    } catch (error) {
      console.error("Failed to clear request stats:", error);
      reply.status(500).send({ error: "Failed to clear request stats" });
    }
  });

  // ========== Backend Batch Test API ==========

  // Mount references for batch test service to use
  (app as any)._server = server;
  (app as any).executeModelTest = executeModelTest;

  // Start a batch test task
  app.post("/api/batch-test/start", async (req: any, reply: any) => {
    const { tests, concurrency = 20 } = req.body;

    if (!tests || !Array.isArray(tests) || tests.length === 0) {
      reply.status(400).send({ success: false, error: "tests array is required and must not be empty" });
      return;
    }

    const clampedConcurrency = Math.max(1, Math.min(50, Number(concurrency) || 20));

    // Get TEST_PROMPT from config
    const serverInstance = (app as any)._server;
    const configService = serverInstance?.configService;
    const testMessage = configService?.get("TEST_PROMPT") || undefined;

    const started = batchTestService.start(
      tests,
      clampedConcurrency,
      (app as any).executeModelTest,
      testMessage
    );

    if (!started) {
      reply.status(409).send({ success: false, error: "A batch test is already running. Cancel it first." });
      return;
    }

    return { success: true, total: tests.length, concurrency: clampedConcurrency };
  });

  // Get batch test task status
  app.get("/api/batch-test/status", async (req: any, reply: any) => {
    return batchTestService.getStatus();
  });

  // Cancel the running batch test task
  app.post("/api/batch-test/cancel", async (req: any, reply: any) => {
    const result = batchTestService.cancel();
    if (!result.success) {
      reply.status(400).send({ success: false, error: "No batch test is currently running" });
      return;
    }
    return result;
  });

  // Batch test results persistence - GET
  app.get("/api/batch-test-results", async (req: any, reply: any) => {
    try {
      const { BATCH_TEST_RESULTS_FILE } = await import("@CCR/shared");
      if (existsSync(BATCH_TEST_RESULTS_FILE)) {
        const content = readFileSync(BATCH_TEST_RESULTS_FILE, 'utf-8');
        return JSON.parse(content);
      }
      return { results: [] };
    } catch (error) {
      console.error("Failed to read batch test results:", error);
      return { results: [] };
    }
  });

  // Batch test results persistence - PUT (overwrite)
  app.put("/api/batch-test-results", async (req: any, reply: any) => {
    try {
      const { BATCH_TEST_RESULTS_FILE } = await import("@CCR/shared");
      if (!existsSync(HOME_DIR)) {
        mkdirSync(HOME_DIR, { recursive: true });
      }
      const body = req.body as { results: any[] };
      writeFileSync(BATCH_TEST_RESULTS_FILE, JSON.stringify(body, null, 2), 'utf-8');
      return { success: true };
    } catch (error) {
      console.error("Failed to save batch test results:", error);
      reply.status(500).send({ error: "Failed to save batch test results" });
    }
  });

  // Watch config file for external changes only (skip internal writes from POST /api/config)
  try {
    // Get ConfigService instance for hot-reload support
    const configService = (server as any).configService as ConfigService;

    configWatcher = watch(CONFIG_FILE, { persistent: true }, async (eventType) => {
      if (eventType === 'change') {
        // Skip if this change was triggered by our own POST /api/config write
        if (isInternalConfigWrite) {
          return;
        }

        // Debounce: fs.watch may fire multiple times for a single write
        if (configWatchDebounceTimer) {
          clearTimeout(configWatchDebounceTimer);
        }
        configWatchDebounceTimer = setTimeout(async () => {
          try {
            // Trigger ConfigService reload with validation
            const result = await configService.reloadWithValidation();

            if (result.valid && result.config) {
              // Reload successful, broadcast new config to SSE clients
              broadcastConfigChange(result.config);
              console.log('Config reloaded from external change');
            } else {
              // Reload failed, keep old config
              console.error('Config reload failed:', result.error);
            }
          } catch (err) {
            console.error('Error reloading config:', err);
          }
        }, 300);
      }
    });
  } catch (err) {
    console.error('Error setting up config file watcher:', err);
  }

  // Watch plugins directory for hot-reload of custom transformers
  try {
    // Check if plugins directory exists, skip watcher if not
    const pluginsDirStats = await stat(PLUGINS_DIR).catch(() => null);
    if (!pluginsDirStats || !pluginsDirStats.isDirectory()) {
      console.log('Plugins directory not found, skipping watcher');
    } else {
      pluginsWatcher = watch(PLUGINS_DIR, { persistent: true }, async (eventType, filename) => {
        // Filter for .js files only
        if (filename && !filename.endsWith('.js')) {
          return;
        }

        // Debounce: fs.watch may fire multiple times for a single write
        if (pluginsWatchDebounceTimer) {
          clearTimeout(pluginsWatchDebounceTimer);
        }
        pluginsWatchDebounceTimer = setTimeout(async () => {
          try {
            console.log('Plugins directory changed, syncing to config.transformers...');

            // Step 1: Scan plugins directory for all .js files
            const { readdirSync } = await import('fs');
            const pluginFiles = readdirSync(PLUGINS_DIR).filter((f: string) => f.endsWith('.js'));
            const pluginPaths = new Set(pluginFiles.map((f: string) => join(PLUGINS_DIR, f)));

            // Step 2: Read current config.transformers
            const currentConfig = await readConfigFile();
            const currentTransformers = Array.isArray(currentConfig.transformers) ? currentConfig.transformers : [];

            // Step 3: Calculate differences
            const newTransformers = [...currentTransformers];
            let configChanged = false;

            // Find plugins that need to be added (in directory but not in config)
            for (const pluginPath of pluginPaths) {
              const existsInConfig = currentTransformers.some(
                (t: any) => t.path === pluginPath
              );
              if (!existsInConfig) {
                console.log(`Adding plugin to config: ${pluginPath}`);
                newTransformers.push({ path: pluginPath, options: {} });
                configChanged = true;
              }
            }

            // Find plugins that need to be removed (in config but not in directory)
            // Only remove entries that point to plugins directory
            for (let i = newTransformers.length - 1; i >= 0; i--) {
              const transformer = newTransformers[i];
              if (transformer.path && transformer.path.startsWith(PLUGINS_DIR)) {
                if (!pluginPaths.has(transformer.path)) {
                  console.log(`Removing plugin from config: ${transformer.path}`);
                  newTransformers.splice(i, 1);
                  configChanged = true;
                }
              }
            }

            // Step 4: Write updated config if changed
            if (configChanged) {
              await backupConfigFile();
              await writeConfigFile({ ...currentConfig, transformers: newTransformers });
              console.log('Config.synced with plugins directory');
            } else {
              console.log('Config already in sync with plugins directory');
            }
          } catch (err) {
            console.error('Error syncing plugins to config:', err);
          }
        }, 300);
      });
      console.log('Plugins directory watcher started:', PLUGINS_DIR);
    }
  } catch (err) {
    console.error('Error setting up plugins directory watcher:', err);
  }

  // Cleanup watchers on server close
  app.addHook('onClose', async () => {
    if (configWatcher) {
      configWatcher.close();
      console.log('Config watcher closed');
    }
    if (pluginsWatcher) {
      pluginsWatcher.close();
      console.log('Plugins watcher closed');
    }
  });

  return server;
};
