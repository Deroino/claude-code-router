/**
 * Claude Code Headers Transformer
 * Adds Claude Code CLI standard headers to requests
 *
 * Synced with packet capture of claude-cli/2.1.59
 */
module.exports = class ClaudeCodeHeadersTransformer {
  static TransformerName = "claude-code-headers";

  constructor(options = {}) {
    this.name = 'claude-code-headers';
  }

  /**
   * Transform request to add Claude Code CLI headers
   */
  async transformRequestIn(request, provider, context) {
    // Claude Code CLI standard headers (from packet capture)
    const claudeCodeHeaders = {
      "Accept": "application/json",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": "0.74.0",
      "X-Stainless-OS": "Linux",
      "X-Stainless-Arch": "x64",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": "v22.16.0",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
      "User-Agent": "claude-cli/2.1.59 (external, cli)",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,token-counting-2024-11-01",
      "accept-language": "*",
      "sec-fetch-mode": "cors",
      "Accept-Encoding": "br, gzip, deflate"
    };

    const config = {
      headers: claudeCodeHeaders,
    };

    // Append beta=true to URL for anyrouter-claude compatibility
    if (provider && provider.api_base_url) {
      const url = new URL(provider.api_base_url);
      url.pathname = "/v1/messages";
      url.searchParams.set("beta", "true");
      config.url = url.toString();
    }

    return {
      body: request,
      config,
    };
  }

  /**
   * Pass through response unchanged
   */
  async transformResponseOut(response) {
    return response;
  }
};
