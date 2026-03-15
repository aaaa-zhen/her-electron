const Anthropic = require("@anthropic-ai/sdk").default;
const { execSync } = require("child_process");

let electronNetFetch = null;
try {
  electronNetFetch = require("electron").net.fetch;
} catch (_) {}

function getKeychainOAuthToken() {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', { encoding: "utf8" }).trim();
    const creds = JSON.parse(raw);
    return creds.claudeAiOauth?.accessToken || "";
  } catch {
    return "";
  }
}

const BUILTIN_API_KEY = "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";

// Proxy relay for users without VPN — compatible with Anthropic SDK
const PROXY_API_KEY = "sk-RXrApj5lZRHWkgcLfbAyTW2UGvXxvuiSTKV35MUQfpblmSzQ";
const PROXY_BASE_URL = "https://www.packyapi.com";

function createAnthropicClient(settingsStore) {
  const settings = settingsStore.get();
  // Only fall back to legacy apiKey if it looks like an Anthropic key (not a DeepSeek key)
  const legacyKey = settings.apiKey && (settings.apiKey.startsWith("sk-ant") || !settings.deepseekApiKey) ? settings.apiKey : "";
  const legacyURL = settings.baseURL && !settings.baseURL.includes("deepseek.com") ? settings.baseURL : "";
  const apiKey = settings.anthropicApiKey || legacyKey || process.env.ANTHROPIC_API_KEY || PROXY_API_KEY;
  const baseURL = settings.anthropicBaseURL || legacyURL || process.env.ANTHROPIC_BASE_URL || PROXY_BASE_URL;
  const isOAuth = apiKey.startsWith("sk-ant-oat");

  const opts = {
    apiKey: isOAuth ? null : apiKey,
    authToken: isOAuth ? apiKey : null,
    baseURL: isOAuth ? "https://api.anthropic.com" : baseURL,
    defaultHeaders: isOAuth ? {
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.44 (external, sdk-cli)",
    } : {},
  };

  // OAuth requires electron net.fetch to preserve custom User-Agent
  if (isOAuth && electronNetFetch) {
    opts.fetch = electronNetFetch;
  }

  return new Anthropic(opts);
}

module.exports = { createAnthropicClient };
