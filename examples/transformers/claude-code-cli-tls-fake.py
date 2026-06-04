#!/usr/bin/env python3
"""
Minimal TLS Fingerprint Proxy
TLS 指纹伪装 + Header 伪装 + 请求体处理（与 main.py 一致）
"""
import json
import hashlib
import secrets
import uuid
import asyncio
import threading
import queue as thread_queue
import os
from contextlib import asynccontextmanager
from curl_cffi import requests as cf_requests
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn

# ============ Claude CLI 指纹常量 ============
_CLI_VERSION = "2.1.72"
_SDK_PACKAGE_VERSION = "0.74.0"
_ANTHROPIC_VERSION = "2023-06-01"
_NODE_VERSION = "v24.3.0"

_ANTHROPIC_BETA_FULL = ",".join([
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "effort-2025-11-24",
])
_ANTHROPIC_BETA_BASIC = "interleaved-thinking-2025-05-14"

# 默认上游地址
DEFAULT_TARGET = "https://anyrouter.top/v1"

# 全局状态
SESSION: cf_requests.Session = None
TARGET_BASE_URL = DEFAULT_TARGET
CLAUDE_CODE_TOOLS = []
CLAUDE_CODE_SYSTEM = []

# 稳定的 session/user id
_SESSION_ID = str(uuid.uuid4())
_USER_HASH = hashlib.sha256(secrets.token_bytes(32)).hexdigest()


def _make_user_id():
    """生成 user_id: user_{hash}_account__session_{uuid}"""
    return f"user_{_USER_HASH}_account__session_{_SESSION_ID}"


def load_claude_code_templates():
    """加载 Claude Code 工具和系统提示"""
    global CLAUDE_CODE_TOOLS, CLAUDE_CODE_SYSTEM
    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    tools_file = os.path.join(base_dir, 'claude_code_tools.json')
    system_file = os.path.join(base_dir, 'claude_code_system.json')
    
    if os.path.exists(tools_file):
        try:
            with open(tools_file, 'r', encoding='utf-8') as f:
                CLAUDE_CODE_TOOLS = json.load(f)
            print(f"[minimal_proxy] Loaded {len(CLAUDE_CODE_TOOLS)} Claude Code tools")
        except Exception as e:
            print(f"[minimal_proxy] Error loading tools: {e}")
    
    if os.path.exists(system_file):
        try:
            with open(system_file, 'r', encoding='utf-8') as f:
                CLAUDE_CODE_SYSTEM = json.load(f)
            print(f"[minimal_proxy] Loaded Claude Code system prompt")
        except Exception as e:
            print(f"[minimal_proxy] Error loading system: {e}")


def create_session() -> cf_requests.Session:
    """创建 Chrome TLS 指纹的 session"""
    return cf_requests.Session(
        impersonate="chrome",
        verify=False,
        timeout=600,
    )


def get_headers(is_stream: bool, model: str, api_key: str, client_headers: dict = None) -> dict:
    """构建与 Claude CLI 一致的 headers"""
    is_code_model = "opus" in model.lower() or "sonnet" in model.lower() or "haiku" in model.lower()
    beta = _ANTHROPIC_BETA_FULL if is_code_model else _ANTHROPIC_BETA_BASIC

    headers = {
        "Accept": "text/event-stream" if is_stream else "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"claude-cli/{_CLI_VERSION} (external, cli)",
        "X-Stainless-Arch": "x64",
        "X-Stainless-Lang": "js",
        "X-Stainless-OS": "MacOS",
        "X-Stainless-Package-Version": _SDK_PACKAGE_VERSION,
        "X-Stainless-Retry-Count": "0",
        "X-Stainless-Runtime": "node",
        "X-Stainless-Runtime-Version": _NODE_VERSION,
        "X-Stainless-Timeout": "600",
        "anthropic-beta": beta,
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-version": _ANTHROPIC_VERSION,
        "x-app": "cli",
        "Accept-Encoding": "gzip, deflate, br, zstd",
    }

    # 如果客户端有更新的 beta flags，使用客户端的
    if client_headers:
        client_beta = client_headers.get("anthropic-beta")
        if client_beta and len(client_beta) > len(beta):
            headers["anthropic-beta"] = client_beta
        client_retry = client_headers.get("X-Stainless-Retry-Count") or client_headers.get("x-stainless-retry-count")
        if client_retry is not None:
            headers["X-Stainless-Retry-Count"] = client_retry

    if api_key:
        headers["x-api-key"] = api_key

    return headers


def process_body(body_json: dict) -> dict:
    """处理请求体：过滤 + 注入（与 main.py 一致）"""
    if not body_json:
        return body_json
    
    # 1. safe_keys 过滤
    safe_keys = {
        'model', 'messages', 'max_tokens', 'metadata', 'stop_sequences',
        'stream', 'system', 'temperature', 'top_k', 'top_p',
        'tools', 'tool_choice', 'thinking', 'service_tier',
        'context_management', 'output_config',
    }
    filtered_body = {k: v for k, v in body_json.items() if k in safe_keys}
    
    # 2. 移除 anyrouter/ 前缀
    model = filtered_body.get('model', '')
    if 'anyrouter/' in model:
        filtered_body['model'] = model.replace('anyrouter/', '')
        model = filtered_body['model']
    
    # 3. 为 Claude 模型注入
    if ('sonnet' in model.lower() or 'opus' in model.lower() or 'haiku' in model.lower()) and CLAUDE_CODE_TOOLS:
        filtered_body['tools'] = CLAUDE_CODE_TOOLS
        
        if CLAUDE_CODE_SYSTEM:
            filtered_body['system'] = CLAUDE_CODE_SYSTEM
        
        # Sonnet/Opus 特有
        if 'sonnet' in model.lower() or 'opus' in model.lower():
            if 'thinking' not in filtered_body:
                filtered_body['thinking'] = {"type": "adaptive"}
            if 'context_management' not in filtered_body:
                filtered_body['context_management'] = {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}
            if 'output_config' not in filtered_body:
                filtered_body['output_config'] = {"effort": "medium"}
        
        if 'metadata' not in filtered_body:
            filtered_body['metadata'] = {"user_id": _make_user_id()}
    
    return filtered_body


# ============ 流式响应桥接 ============
def _stream_worker(session, method, url, headers, json_data, q):
    """Worker thread: 执行 curl_cffi 流式请求"""
    try:
        resp = session.request(
            method=method,
            url=url,
            headers=headers,
            json=json_data,
            stream=True,
            timeout=600,
        )
        q.put(("status", resp.status_code))
        for chunk in resp.iter_content():
            q.put(("data", chunk))
        q.put(("end", None))
    except Exception as e:
        q.put(("error", e))


async def _async_chunks(q):
    """Async generator 读取队列中的数据块"""
    loop = asyncio.get_running_loop()
    while True:
        msg_type, value = await loop.run_in_executor(None, q.get)
        if msg_type in ("end", "error"):
            break
        if msg_type == "data":
            yield value


# ============ FastAPI App with Lifespan ============
@asynccontextmanager
async def lifespan(app):
    global SESSION
    load_claude_code_templates()
    SESSION = create_session()
    print(f"[minimal_proxy] Started, TLS: chrome")
    yield
    if SESSION:
        SESSION.close()


app = FastAPI(lifespan=lifespan)


# ============ 路由 ============
@app.get("/health")
async def health():
    """健康检查"""
    return {
        "status": "ok",
        "tls": "chrome",
        "tools_loaded": len(CLAUDE_CODE_TOOLS),
    }


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request):
    """核心代理路由"""
    global SESSION, TARGET_BASE_URL

    # 构建目标 URL
    target_override = request.headers.get("X-Target-Base-Url", "")
    target_base = target_override if target_override else TARGET_BASE_URL
    target_url = f"{target_base}/{path}"
    if path == "messages":
        target_url += "?beta=true"

    # 获取请求体
    body_bytes = await request.body()
    body_json = {}
    is_stream = False
    
    if body_bytes:
        try:
            body_json = json.loads(body_bytes)
            # 处理请求体：过滤 + 注入
            body_json = process_body(body_json)
            is_stream = body_json.get('stream', False)
        except:
            pass

    model = body_json.get('model', '') if body_json else ''

    # 提取 API Key
    api_key = request.headers.get("x-api-key", "")
    if not api_key:
        bearer = request.headers.get("Authorization", "")
        if bearer.startswith("Bearer "):
            api_key = bearer[7:]

    # 构建 headers
    headers = get_headers(is_stream, model, api_key, dict(request.headers))

    if is_stream:
        # 流式请求
        q = thread_queue.Queue(maxsize=256)
        t = threading.Thread(
            target=_stream_worker,
            args=(SESSION, request.method, target_url, headers, body_json, q),
            daemon=True,
        )
        t.start()

        loop = asyncio.get_running_loop()
        msg_type, value = await loop.run_in_executor(None, q.get)

        if msg_type == "error":
            return Response(
                content=json.dumps({"error": {"message": str(value)}}),
                status_code=500,
                media_type="application/json",
            )

        status_code = value

        if status_code in [403, 500]:
            # 错误响应，收集完整内容
            chunks = []
            while True:
                mt, v = await loop.run_in_executor(None, q.get)
                if mt == "data":
                    chunks.append(v if isinstance(v, bytes) else v.encode())
                elif mt in ("end", "error"):
                    break
            return Response(
                content=b"".join(chunks),
                status_code=status_code,
                media_type="application/json",
            )

        return StreamingResponse(
            _async_chunks(q),
            status_code=status_code,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    else:
        # 非流式请求
        resp = await asyncio.to_thread(
            SESSION.request,
            request.method,
            target_url,
            headers=headers,
            json=body_json,
            timeout=600,
        )

        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type="application/json",
        )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--target", default=DEFAULT_TARGET, help="Upstream API base URL")
    args = parser.parse_args()

    TARGET_BASE_URL = args.target.rstrip("/v1").rstrip("/")

    print(f"[minimal_proxy] Listening on http://{args.host}:{args.port}")
    print(f"[minimal_proxy] Target: {TARGET_BASE_URL}")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")