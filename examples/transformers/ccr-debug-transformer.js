const fs = require('fs');
const path = require('path');

module.exports = class DebugTransformer {
  static TransformerName = "debug";

  constructor(options = {}) {
    this.name = 'debug';
    this.logFilePath = options.logFilePath || '/tmp/ccr-debug-transformer.log';
    this.logOnlyOnError = options.logOnlyOnError !== undefined ? options.logOnlyOnError : false;
    this.requestBuffer = new Map(); // 存储请求数据，出错时才写入
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
      this.log('REQUEST', requestData);
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
      this.log('RESPONSE', responseData);
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

    // 记录错误响应
    this.log('RESPONSE (ERROR)', responseData);

    // 如果只在错误时记录，也要记录对应的请求
    if (this.logOnlyOnError && requestId && this.requestBuffer.has(requestId)) {
      this.log('REQUEST (for error)', this.requestBuffer.get(requestId));
    }

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