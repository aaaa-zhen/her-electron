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

function createAnthropicClient(settingsStore) {
  const settings = settingsStore.get();
  const apiKey = settings.apiKey || process.env.ANTHROPIC_API_KEY || getKeychainOAuthToken();
  const baseURL = settings.baseURL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
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
