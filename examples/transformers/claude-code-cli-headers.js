/**
 * Claude Code TLS Proxy Transformer
 * 
 * 自动管理 Python TLS 代理服务，实现完整的 TLS 指纹伪装
 * - 检测代理服务是否运行
 * - 自动启动代理服务（后台）
 * - 重写请求 URL 到代理地址
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ============ 配置 ============
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 18765;
const PROXY_STARTUP_TIMEOUT = 5000;  // 启动超时 5 秒
const HEALTH_CHECK_INTERVAL = 30000; // 健康检查间隔 30 秒

// Python 代理文件路径
const PROXY_SCRIPT = path.join(__dirname, 'claude-code-cli-tls-fake.py');

// 全局状态
let proxyProcess = null;
let lastHealthCheck = 0;
let isStarting = false;

// ============ 工具函数 ============

/**
 * 检查端口是否可连接
 */
function checkPort(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port: port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * 启动 Python 代理进程
 */
async function startProxyProcess() {
  if (isStarting) {
    // 等待启动完成
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return checkPort(PROXY_HOST, PROXY_PORT);
  }

  isStarting = true;

  try {
    // 检查脚本是否存在
    if (!fs.existsSync(PROXY_SCRIPT)) {
      console.error(`[tls-proxy] Proxy script not found: ${PROXY_SCRIPT}`);
      return false;
    }

    console.log(`[tls-proxy] Starting Python proxy on port ${PROXY_PORT}...`);

    // 后台启动 Python 进程
    proxyProcess = spawn('python3', [PROXY_SCRIPT, '--port', String(PROXY_PORT)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(PROXY_SCRIPT),
    });

    // 分离子进程，让它独立运行
    proxyProcess.unref();

    // 日志输出
    proxyProcess.stdout?.on('data', (data) => {
      console.log(`[tls-proxy] ${data.toString().trim()}`);
    });
    proxyProcess.stderr?.on('data', (data) => {
      console.error(`[tls-proxy] ${data.toString().trim()}`);
    });

    proxyProcess.on('exit', (code) => {
      console.log(`[tls-proxy] Process exited with code ${code}`);
      proxyProcess = null;
    });

    // 等待服务启动
    const startTime = Date.now();
    while (Date.now() - startTime < PROXY_STARTUP_TIMEOUT) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await checkPort(PROXY_HOST, PROXY_PORT)) {
        console.log(`[tls-proxy] Proxy started successfully on port ${PROXY_PORT}`);
        return true;
      }
    }

    console.error(`[tls-proxy] Failed to start proxy within ${PROXY_STARTUP_TIMEOUT}ms`);
    return false;
  } finally {
    isStarting = false;
  }
}

/**
 * 确保代理服务运行
 */
async function ensureProxyRunning() {
  // 缓存健康检查结果
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
    // 假设上次检查后仍在运行
    return true;
  }

  const isRunning = await checkPort(PROXY_HOST, PROXY_PORT);
  if (isRunning) {
    lastHealthCheck = now;
    return true;
  }

  // 需要启动
  lastHealthCheck = 0;
  return await startProxyProcess();
}

// ============ Transformer 类 ============
module.exports = class ClaudeCodeHeadersTransformer {
  static TransformerName = "claude-code-headers";

  constructor(options = {}) {
    this.name = 'claude-code-cli-headers';
    this.defaultTarget = options.defaultTarget || 'https://anyrouter.top/v1';
  }

  /**
   * 转换请求：重写 URL 到代理地址
   */
  async transformRequestIn(request, provider, context) {
    try {
      // 确保代理运行
      const proxyReady = await ensureProxyRunning();

      if (!proxyReady) {
        console.error('[tls-proxy] Proxy not available, falling back to direct request');
        return this._fallbackConfig(request, provider);
      }

      // 提取 API Key
      const apiKey = request?.apiKey || request?.api_key || provider?.api_key || '';

      // 提取目标地址（如果 provider 有自定义地址）
      const targetBaseUrl = provider?.api_base_url || this.defaultTarget;

      // 核心：改 URL 指向代理，让 core router 正常发请求
      return {
        body: request,
        config: {
          url: `http://${PROXY_HOST}:${PROXY_PORT}/v1/messages`,
          headers: {
            'x-api-key': apiKey,
            'X-Target-Base-Url': targetBaseUrl,
          },
        },
      };
    } catch (error) {
      console.error('[tls-proxy] Error:', error.message);
      return this._fallbackConfig(request, provider);
    }
  }

  /**
   * 降级配置（直接请求）
   */
  _fallbackConfig(request, provider) {
    const config = {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": request?.apiKey || request?.api_key || provider?.api_key || '',
      },
    };

    if (provider?.api_base_url) {
      try {
        const url = new URL(provider.api_base_url);
        url.pathname = "/v1/messages";
        config.url = url.toString();
      } catch (e) {
        // 忽略 URL 解析错误
      }
    }

    return {
      body: request,
      config,
    };
  }
};
