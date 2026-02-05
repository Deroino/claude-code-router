import Server, { calculateTokenCount, TokenizerService } from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { CONFIG_FILE } from "@CCR/shared";
import { join } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync, watch, openSync, readSync, closeSync } from "fs";
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
import { ConfigService } from "@musistudio/llms";

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
    return await readConfigFile();
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
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    // Add lastModified timestamp
    const configWithTimestamp = {
      ...newConfig,
      _lastModified: Date.now()
    };

    await writeConfigFile(configWithTimestamp);
    return { success: true, message: "Config saved successfully", lastModified: configWithTimestamp._lastModified };
  });

  // Add endpoint to test a specific provider+model
  app.post("/api/model-test", async (req: any, reply: any) => {
    // @ts-ignore - requestStatsService is exported but not in type definitions
    const { requestStatsService } = await import("@musistudio/llms");

    try {
      const { provider, model, message } = req.body;

      if (!provider || !model) {
        reply.status(400).send({ success: false, error: "provider and model are required" });
        return;
      }

      const serverInstance = (app as any)._server;
      const providerService = serverInstance.providerService;
      const transformerService = serverInstance.transformerService;

      // Get provider
      const providerData = providerService.getProvider(provider);
      if (!providerData) {
        reply.status(404).send({ success: false, error: `Provider '${provider}' not found` });
        return;
      }

      // Check if model exists in provider
      if (!providerData.models.includes(model)) {
        reply.status(400).send({ success: false, error: `Model '${model}' not found in provider '${provider}'` });
        return;
      }

      // Construct test request
      const configService = serverInstance.configService;
      const testMessage = message || configService.get("TEST_PROMPT") || "Hello, please respond with 'OK' if you can understand this message.";
      const requestBody = {
        model: model,
        messages: [
          {
            role: "user",
            content: testMessage
          }
        ],
        max_tokens: 300,
        stream: false
      };

      // Apply provider transformers if configured
      let processedRequest = requestBody;
      if (providerData.transformer?.use) {
        for (const transformer of providerData.transformer.use) {
          if (transformer && typeof transformer.transformRequestIn === "function") {
            processedRequest = await transformer.transformRequestIn(processedRequest);
          }
        }
      }

      // Apply model-specific transformers if configured
      if (providerData.transformer?.[model]?.use) {
        for (const transformer of providerData.transformer[model].use) {
          if (transformer && typeof transformer.transformRequestIn === "function") {
            processedRequest = await transformer.transformRequestIn(processedRequest);
          }
        }
      }

      // Send request to provider
      // Get API key with rotation support
      const selectedApiKey = typeof providerData.apiKey === 'string'
        ? providerData.apiKey
        : providerService.getApiKey(providerData.name, providerData.apiKey);

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 seconds timeout

      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${selectedApiKey}`
        },
        body: JSON.stringify(processedRequest),
        signal: controller.signal
      };

      // Use proxy if configured
      const httpsProxy = configService.getHttpsProxy();
      if (httpsProxy) {
        (fetchOptions as any).dispatcher = new ProxyAgent(httpsProxy);
      }

      const response = await fetch(providerData.baseUrl, fetchOptions);

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();

        // Log the full response structure for debugging
        app.log.debug({ responseData: data }, 'Model test response structure');

        // Extract response text from model
        let responseText = '';
        if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
          responseText = data.choices[0].message.content;
        } else if (data.content && data.content[0] && data.content[0].text) {
          responseText = data.content[0].text;
        } else {
          // Log unrecognized format
          app.log.warn({ responseData: data }, 'Unrecognized response format in model test');
        }

        // Check if response is empty after trimming (only remove leading/trailing whitespace)
        const trimmedResponse = responseText.trim();
        if (!trimmedResponse) {
          // Record failure for empty response with full response body for debugging
          const errorMessage = `Model returned empty response. Raw response: ${JSON.stringify(data)}`;
          requestStatsService.recordFailure(provider, model, processedRequest, errorMessage, 200);
          reply.status(200).send({
            success: false,
            error: "Model returned empty response",
            rawResponse: data,
            debug: {
              message: "Response extraction failed or content was empty",
              responseStructure: Object.keys(data),
              extractedText: responseText
            }
          });
          return;
        }

        // Record success statistics
        requestStatsService.recordSuccess(provider, model, processedRequest, data);
        return {
          success: true,
          status: response.status,
          response: responseText,
          data: data
        };
      } else {
        const errorText = await response.text();
        let errorData = errorText;

        // Check if it's gzip compressed or garbled error
        if (isCompressedError(errorText)) {
          // Log the original garbled error for debugging
          app.log.warn({
            originalError: errorText.substring(0, 200) + (errorText.length > 200 ? '...' : ''),
            provider,
            model,
            status: response.status,
            errorSize: errorText.length
          }, 'Received compressed/garbled error from provider');

          // Replace with readable error information
          errorData = replaceCompressedError(errorText, provider, model, response.status);
        } else {
          // Try to parse error as JSON to remove escaped characters
          try {
            const parsed = JSON.parse(errorText);
            errorData = parsed;
          } catch (e) {
            // If not valid JSON, keep as is
          }
        }

        // Record failure statistics with original error text (not the readable version)
        requestStatsService.recordFailure(provider, model, processedRequest, errorText, response.status);

        // Always return 200 to avoid triggering frontend auth redirect
        // Include the original provider status in the response
        reply.status(200).send({
          success: false,
          status: response.status,
          error: errorData
        });
        return;
      }
    } catch (error: any) {
      // Handle timeout error
      if (error.name === 'AbortError') {
        // Record failure statistics for timeout
        requestStatsService.recordFailure(req.body.provider, req.body.model, req.body, "Request timeout (10 seconds)", 504);
        // Always return 200 to avoid triggering frontend auth redirect
        reply.status(200).send({
          success: false,
          status: 504,
          error: "Request timeout (10 seconds)"
        });
        return;
      }

      // Build detailed error message
      const serverInstance = (app as any)._server;
      const providerService = serverInstance.providerService;
      const providerData = providerService.getProvider(req.body.provider);
      const targetUrl = providerData?.baseUrl || 'unknown';

      let errorDetail = `Failed to connect to provider API at ${targetUrl}`;
      if (error.cause) {
        errorDetail += `\nCause: ${error.cause}`;
      }
      if (error.code) {
        errorDetail += `\nError code: ${error.code}`;
      }
      errorDetail += `\nOriginal error: ${error.message || 'Unknown error'}`;

      // Record failure statistics for other errors
      requestStatsService.recordFailure(req.body.provider, req.body.model, req.body, errorDetail, 500);

      // Always return 200 to avoid triggering frontend auth redirect
      reply.status(200).send({
        success: false,
        status: 500,
        error: errorDetail
      });
      return;
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

  // Get request stats
  app.get("/api/request-stats", async (req: any, reply: any) => {
    try {
      // @ts-ignore - requestStatsService is exported but not in type definitions
      const { requestStatsService } = await import("@musistudio/llms");
      const allStats = requestStatsService.getAllStats() as Map<string, any>;
      const statsArray: Array<{ key: string; provider: string; model: string; success: number; fail: number; lastRequest?: any }> = [];
      allStats.forEach((value: any, key: string) => {
        statsArray.push({
          key,
          provider: key.split(':')[0],
          model: key.split(':')[1],
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
    // @ts-ignore - requestStatsService is exported but not in type definitions
    const { requestStatsService } = await import("@musistudio/llms");

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
    const initialStats: Array<{ key: string; provider: string; model: string; success: number; fail: number; lastRequest?: any }> = [];
    allStats.forEach((value: any, key: string) => {
      initialStats.push({
        key,
        provider: key.split(':')[0],
        model: key.split(':')[1],
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
      const data = {
        type: 'update',
        data: {
          key: update.key,
          provider: update.key.split(':')[0],
          model: update.key.split(':')[1],
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
      // @ts-ignore - requestStatsService is exported but not in type definitions
      const { requestStatsService } = await import("@musistudio/llms");
      requestStatsService.clearAll();
      return { success: true, message: "Request stats cleared successfully" };
    } catch (error) {
      console.error("Failed to clear request stats:", error);
      reply.status(500).send({ error: "Failed to clear request stats" });
    }
  });

  // Watch config file for external changes
  try {
    // Get ConfigService instance for hot-reload support
    const configService = (server as any).configService as ConfigService;

    configWatcher = watch(CONFIG_FILE, { persistent: true }, async (eventType) => {
      if (eventType === 'change') {
        try {
          // Trigger ConfigService reload with validation
          const result = await configService.reloadWithValidation();

          if (result.valid && result.config) {
            // Reload successful, broadcast new config to SSE clients
            broadcastConfigChange(result.config);
            console.log('Config reloaded successfully');
          } else {
            // Reload failed, keep old config
            console.error('Config reload failed:', result.error);
          }
        } catch (err) {
          console.error('Error reloading config:', err);
        }
      }
    });
  } catch (err) {
    console.error('Error setting up config file watcher:', err);
  }

  return server;
};
