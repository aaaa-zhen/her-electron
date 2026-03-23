const DEFAULT_MODEL = "claude-sonnet-4-6";
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";

const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", description: "最强、深度推理" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", description: "均衡、高性价比" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", description: "快速、低成本" },
];

const INPUT_COST_PER_TOKEN = 1 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 4 / 1_000_000;

module.exports = {
  DEFAULT_MODEL,
  SUMMARY_MODEL,
  AVAILABLE_MODELS,
  INPUT_COST_PER_TOKEN,
  OUTPUT_COST_PER_TOKEN,
};
