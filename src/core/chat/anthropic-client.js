const OpenAI = require("openai");

const DEFAULT_API_KEY = "sk-g75PvElaEZCBo653IV2TzqzSq5FXPtWlEL5mVkS3sqAIahFB";
const DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

function createClient(settingsStore) {
  const settings = settingsStore.get();
  const apiKey = settings.apiKey || DEFAULT_API_KEY;
  const baseURL = settings.baseURL || DEFAULT_BASE_URL;
  return new OpenAI({ apiKey, baseURL });
}

// Keep backward-compatible alias
const createAnthropicClient = createClient;

module.exports = { createClient, createAnthropicClient };
