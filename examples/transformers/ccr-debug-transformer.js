const fs = require('fs');
const path = require('path');

module.exports = class DebugTransformer {
  static TransformerName = "debug";

  constructor(options = {}) {
    this.name = 'ccr-debug-transformer';
    this.logFilePath = options.logFilePath || '/tmp/ccr-debug-transformer.log';
    this.logOnlyOnError = options.logOnlyOnError !== undefined ? options.logOnlyOnError : false;
    this.requestBuffer = new Map(); // 存储请求数据，出错时才写入
    this.maxPairs = typeof options.maxPairs === 'number' && options.maxPairs > 0 ? options.maxPairs : 3;
    this.recentPairs = [];
    this.initializeRecentPairs();
  }

  async transformRequestIn(request, provider, context) {
    const requestId = this.generateRequestId();

    const requestData = {
      timestamp: new Date().toISOString(),
      requestId,
      provider: provider.name,
      model: request.model,
      messagesCount: request.messages?.length || 0,
      toolsCount: request.tools?.length || 0,
      hasStreaming: request.stream || false,
      request: this.sanitizeRequest(request)
    };

    // 如果不是只在错误时记录，直接写入日志
    if (!this.logOnlyOnError) {
      this.recordRequest(requestId, requestData);
    } else {
      // 否则缓存请求，出错时才写入
      this.requestBuffer.set(requestId, requestData);
    }

    // 将 requestId 附加到 context，以便响应时能匹配
    if (context) {
      context.requestId = requestId;
    }

    return request;
  }

  async transformResponseIn(response, context) {
    const requestId = context?.requestId;
    const isError = !response.ok;

    // 读取响应体
    const bodyText = await response.text();
    const responseBody = this.parseResponseBody(bodyText);

    const responseData = {
      timestamp: new Date().toISOString(),
      requestId,
      status: response.status,
      statusText: response.statusText,
      isError,
      headers: Object.fromEntries(response.headers.entries()),
      response: responseBody
    };

    // 只在非错误且不为"仅错误日志"模式时记录
    // 错误情况由 logErrorResponse 处理
    if (!isError && !this.logOnlyOnError) {
      this.recordResponse(requestId, responseData);
    }

    // 清理缓存
    if (requestId) {
      this.requestBuffer.delete(requestId);
    }

    // 重新创建 Response 对象并返回
    return this.cloneResponse(response, bodyText);
  }

  // 专门用于记录错误响应的方法（不消耗 body）
  async logErrorResponse(response, errorText, context) {
    const requestId = context?.requestId;
    const isError = !response.ok;

    const responseBody = this.parseResponseBody(errorText);

    const responseData = {
      timestamp: new Date().toISOString(),
      requestId,
      status: response.status,
      statusText: response.statusText,
      isError,
      headers: Object.fromEntries(response.headers.entries()),
      response: responseBody
    };

    // 如果只在错误时记录，也要记录对应的请求
    if (this.logOnlyOnError && requestId && this.requestBuffer.has(requestId)) {
      this.recordRequest(requestId, this.requestBuffer.get(requestId));
    }

    // 记录错误响应
    this.recordResponse(requestId, responseData);

    // 清理缓存
    if (requestId) {
      this.requestBuffer.delete(requestId);
    }
  }

  parseResponseBody(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // 重新创建 Response 对象，避免 body 被消耗
  async cloneResponse(response, bodyText) {
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      headers.set(key, value);
    });

    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  }

  sanitizeRequest(request) {
    // 创建请求的副本，隐藏敏感信息
    const sanitized = {
      model: request.model,
      messages: request.messages?.map(msg => {
        // 处理 content 可能是字符串或数组的情况
        let contentPreview = '';
        let hasImages = false;

        if (typeof msg.content === 'string') {
          contentPreview = msg.content.substring(0, 500) + (msg.content.length > 500 ? '... (truncated)' : '');
        } else if (Array.isArray(msg.content)) {
          hasImages = msg.content.some(c => c.type === 'image');
          const textContent = msg.content.find(c => c.type === 'text');
          if (textContent && typeof textContent.text === 'string') {
            contentPreview = textContent.text.substring(0, 500) + (textContent.text.length > 500 ? '... (truncated)' : '');
          }
          contentPreview += ` [${msg.content.length} items, ${hasImages ? 'includes images' : 'text only'}]`;
        }

        return {
          role: msg.role,
          content: contentPreview,
          hasImages
        };
      }),
      tools: request.tools?.map(tool => ({
        name: tool.function?.name,
        description: tool.function?.description?.substring(0, 200),
        parameters: tool.function?.parameters ? {
          type: tool.function.parameters.type,
          propertiesCount: Object.keys(tool.function.parameters.properties || {}).length
        } : undefined
      })),
      stream: request.stream,
      temperature: request.temperature,
      max_tokens: request.max_tokens
    };

    return sanitized;
  }

  initializeRecentPairs() {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return;
      }

      const existingContent = fs.readFileSync(this.logFilePath, 'utf8');
      const entries = existingContent
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(entry => entry.requestId);

      const pairMap = new Map();
      for (const entry of entries) {
        const pair = pairMap.get(entry.requestId) || { requestId: entry.requestId };
        if (entry.type && entry.type.startsWith('REQUEST')) {
          pair.request = entry;
        } else if (entry.type && entry.type.startsWith('RESPONSE')) {
          pair.response = entry;
        }

        pairMap.set(entry.requestId, pair);
      }

      this.recentPairs = Array.from(pairMap.values())
        .filter(pair => pair.request || pair.response)
        .slice(-this.maxPairs);

      this.persistRecentPairs();
    } catch (error) {
      console.warn(`[DebugTransformer] Failed to initialize log pairs: ${error.message}`);
      this.recentPairs = [];
      try {
        fs.writeFileSync(this.logFilePath, '', 'utf8');
      } catch (writeError) {
        console.error(`[DebugTransformer] Failed to reset log file: ${writeError.message}`);
      }
    }
  }

  persistRecentPairs() {
    try {
      if (this.recentPairs.length > this.maxPairs) {
        this.recentPairs = this.recentPairs.slice(-this.maxPairs);
      }

      const lines = [];
      for (const pair of this.recentPairs) {
        if (pair.request) {
          lines.push(JSON.stringify(pair.request));
        }
        if (pair.response) {
          lines.push(JSON.stringify(pair.response));
        }
      }

      fs.writeFileSync(this.logFilePath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    } catch (error) {
      console.error(`[DebugTransformer] Failed to persist log pairs: ${error.message}`);
    }
  }

  recordRequest(requestId, requestData) {
    const existingPair = this.recentPairs.find(pair => pair.requestId === requestId);
    const sanitizedEntry = { type: 'REQUEST', ...requestData };

    if (existingPair) {
      existingPair.request = sanitizedEntry;
    } else {
      this.recentPairs.push({ requestId, request: sanitizedEntry });
    }

    this.persistRecentPairs();
  }

  recordResponse(requestId, responseData) {
    const targetId = requestId || this.generateRequestId();
    const existingPair = this.recentPairs.find(pair => pair.requestId === targetId);
    const sanitizedEntry = { type: responseData.isError ? 'RESPONSE (ERROR)' : 'RESPONSE', ...responseData };

    if (existingPair) {
      existingPair.response = sanitizedEntry;
    } else {
      this.recentPairs.push({ requestId: targetId, response: sanitizedEntry });
    }

    this.persistRecentPairs();
  }

  log(type, data) {
    const logEntry = {
      type,
      ...data
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    try {
      fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    } catch (error) {
      console.error(`[DebugTransformer] Failed to write to log file: ${error.message}`);
    }
  }

  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
};
