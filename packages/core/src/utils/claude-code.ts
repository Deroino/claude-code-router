export const CLAUDE_CODE_BETA_HEADER = "claude-code-20250219";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export function extractClaudeCodeSessionId(userId: unknown): string | undefined {
  if (typeof userId !== "string") {
    return undefined;
  }

  const trimmed = userId.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const sessionId = (parsed as Record<string, unknown>).session_id;
        if (typeof sessionId === "string" && sessionId.trim()) {
          return sessionId.trim();
        }
      }
    } catch {
      // Fall back to the legacy marker parser below.
    }
  }

  const legacyMatch = trimmed.match(/_session_([a-f0-9-]+)/i);
  return legacyMatch?.[1];
}

export function isClaudeCodeMessagesRequest(
  requestUrl: unknown,
  headers?: Record<string, unknown>,
  body?: Record<string, any>
): boolean {
  if (typeof requestUrl !== "string") {
    return false;
  }

  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return false;
  }

  if (url.pathname !== "/v1/messages") {
    return false;
  }

  return (
    url.searchParams.has("beta") ||
    Boolean(getHeaderValue(headers, "anthropic-beta")) ||
    Boolean(extractClaudeCodeSessionId(body?.metadata?.user_id))
  );
}

export function mergeClaudeCodeRequestQuery<T extends URL | string>(
  targetUrl: T,
  requestUrl: unknown
): T {
  if (typeof requestUrl !== "string") {
    return targetUrl;
  }

  let sourceUrl: URL;
  let mergedUrl: URL;
  try {
    sourceUrl = new URL(requestUrl, "http://127.0.0.1");
    mergedUrl = new URL(targetUrl.toString());
  } catch {
    return targetUrl;
  }

  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (!mergedUrl.searchParams.has(key)) {
      mergedUrl.searchParams.append(key, value);
    }
  }

  return (typeof targetUrl === "string" ? mergedUrl.toString() : mergedUrl) as T;
}

export function ensureClaudeCodeAnthropicHeaders(
  headers?: Headers | Record<string, unknown>
): Record<string, unknown> {
  const nextHeaders = headersToRecord(headers);
  setHeaderValue(
    nextHeaders,
    "anthropic-beta",
    mergeClaudeCodeBetaHeader(getHeaderValue(nextHeaders, "anthropic-beta"))
  );

  if (!getHeaderValue(nextHeaders, "anthropic-version")) {
    setHeaderValue(
      nextHeaders,
      "anthropic-version",
      DEFAULT_ANTHROPIC_VERSION
    );
  }

  return nextHeaders;
}

function mergeClaudeCodeBetaHeader(currentValue: string | undefined): string {
  if (!currentValue) {
    return CLAUDE_CODE_BETA_HEADER;
  }

  const values = currentValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.includes(CLAUDE_CODE_BETA_HEADER)) {
    return values.join(",");
  }

  return [CLAUDE_CODE_BETA_HEADER, ...values].join(",");
}

function headersToRecord(
  headers?: Headers | Record<string, unknown>
): Record<string, unknown> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  return { ...headers };
}

function getHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const targetName = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === targetName
  );
  const value = entry?.[1];

  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string").join(",");
  }

  return typeof value === "string" ? value : undefined;
}

function setHeaderValue(
  headers: Record<string, unknown>,
  name: string,
  value: string
): void {
  const targetName = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetName) {
      delete headers[key];
    }
  }

  headers[name] = value;
}
