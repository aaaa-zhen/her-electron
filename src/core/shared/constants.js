const DEFAULT_MODEL = "claude-sonnet-4-6";
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";

const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

// DeepSeek pricing (CNY per million tokens, converted to approximate USD)
const DEEPSEEK_INPUT_COST_PER_TOKEN = 1 / 1_000_000;   // cache miss ¥1/M ≈ $0.14/M
const DEEPSEEK_OUTPUT_COST_PER_TOKEN = 2 / 1_000_000;   // ¥2/M ≈ $0.28/M

const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner"];

// Kimi pricing (CNY per million tokens, converted to approximate USD)
const KIMI_INPUT_COST_PER_TOKEN = 1 / 1_000_000;
const KIMI_OUTPUT_COST_PER_TOKEN = 3 / 1_000_000;

const KIMI_MODELS = ["kimi-latest", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "moonshot-v1-auto"];

/**
 * Detect provider from model name and optional base URL.
 * When deepseekBaseURL points to a non-DeepSeek endpoint (e.g. CLIProxyAPI),
 * route all models through the OpenAI-compatible (deepseek) client.
 */
function getProviderForModel(model, deepseekBaseURL) {
  if (!model) return "anthropic";
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("kimi") || model.startsWith("moonshot")) return "kimi";
  if (deepseekBaseURL && !deepseekBaseURL.includes("deepseek.com")) return "deepseek";
  return "anthropic";
}

module.exports = {
  DEFAULT_MODEL,
  SUMMARY_MODEL,
  INPUT_COST_PER_TOKEN,
  OUTPUT_COST_PER_TOKEN,
  DEEPSEEK_INPUT_COST_PER_TOKEN,
  DEEPSEEK_OUTPUT_COST_PER_TOKEN,
  DEEPSEEK_MODELS,
  KIMI_INPUT_COST_PER_TOKEN,
  KIMI_OUTPUT_COST_PER_TOKEN,
  KIMI_MODELS,
  getProviderForModel,
};
