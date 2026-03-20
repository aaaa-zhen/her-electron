const DEFAULT_MODEL = "kimi-k2-turbo-preview";
const SUMMARY_MODEL = "kimi-k2-turbo-preview";

const AVAILABLE_MODELS = [
  { id: "kimi-k2-turbo-preview", name: "Kimi K2 Turbo", description: "快速、高性价比" },
  { id: "kimi-k2.5", name: "Kimi K2.5", description: "最强、更深度思考" },
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
