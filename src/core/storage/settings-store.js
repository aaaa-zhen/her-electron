const path = require("path");
const { JsonFileStore } = require("./json-file");
const { DEFAULT_MODEL, getProviderForModel } = require("../shared/constants");

class SettingsStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "settings.json"), () => ({}));
    this._migrated = false;
  }

  /** Migrate legacy single apiKey/baseURL → per-provider fields (one-time). */
  _migrateIfNeeded(settings) {
    if (this._migrated) return settings;
    if (!settings.apiKey) { this._migrated = true; return settings; }
    // Skip if already migrated (per-provider key has a real value, not just default "")
    const raw = this.read();
    if (raw.anthropicApiKey || raw.deepseekApiKey) { this._migrated = true; return settings; }

    const key = settings.apiKey;
    const url = settings.baseURL || "";
    const provider = url.includes("deepseek.com") ? "deepseek" : getProviderForModel(settings.model);

    if (provider === "deepseek") {
      settings.deepseekApiKey = key;
      settings.deepseekBaseURL = url || "https://api.deepseek.com";
    } else {
      settings.anthropicApiKey = key;
      settings.anthropicBaseURL = url || "https://www.packyapi.com";
    }
    this._migrated = true;
    this.write(settings);
    return settings;
  }

  get() {
    const settings = this.read();
    const merged = {
      baseURL: "https://www.packyapi.com",
      model: DEFAULT_MODEL,
      anthropicApiKey: "",
      anthropicBaseURL: "https://www.packyapi.com",
      deepseekApiKey: "",
      deepseekBaseURL: "https://api.deepseek.com",
      kimiApiKey: "",
      kimiBaseURL: "https://api.moonshot.cn/v1",
      relationshipProfile: null,
      relationshipSetupCompleted: false,
      browserHistoryEnabled: true,
      browserHistoryScanHour: 4,
      remoteAgentEnabled: false,
      remoteRelayUrl: "",
      remoteDeviceToken: "",
      remoteClientToken: "",
      remotePairId: "",
      newsBriefing: null,
      ...settings,
    };
    return this._migrateIfNeeded(merged);
  }

  update(patch) {
    const next = { ...this.get() };
    if (patch.apiKey !== undefined && patch.apiKey !== "") next.apiKey = patch.apiKey;
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.anthropicApiKey !== undefined && patch.anthropicApiKey !== "") next.anthropicApiKey = patch.anthropicApiKey;
    if (patch.anthropicBaseURL !== undefined) next.anthropicBaseURL = patch.anthropicBaseURL;
    if (patch.deepseekApiKey !== undefined && patch.deepseekApiKey !== "") next.deepseekApiKey = patch.deepseekApiKey;
    if (patch.deepseekBaseURL !== undefined) next.deepseekBaseURL = patch.deepseekBaseURL;
    if (patch.kimiApiKey !== undefined && patch.kimiApiKey !== "") next.kimiApiKey = patch.kimiApiKey;
    if (patch.kimiBaseURL !== undefined) next.kimiBaseURL = patch.kimiBaseURL;
    if (patch.relationshipProfile !== undefined) next.relationshipProfile = patch.relationshipProfile;
    if (patch.relationshipSetupCompleted !== undefined) next.relationshipSetupCompleted = Boolean(patch.relationshipSetupCompleted);
    if (patch.browserHistoryEnabled !== undefined) next.browserHistoryEnabled = Boolean(patch.browserHistoryEnabled);
    if (patch.browserHistoryScanHour !== undefined) next.browserHistoryScanHour = patch.browserHistoryScanHour;
    if (patch.remoteAgentEnabled !== undefined) next.remoteAgentEnabled = Boolean(patch.remoteAgentEnabled);
    if (patch.remoteRelayUrl !== undefined) next.remoteRelayUrl = patch.remoteRelayUrl;
    if (patch.remoteDeviceToken !== undefined) next.remoteDeviceToken = patch.remoteDeviceToken;
    if (patch.remoteClientToken !== undefined) next.remoteClientToken = patch.remoteClientToken;
    if (patch.remotePairId !== undefined) next.remotePairId = patch.remotePairId;
    if (patch.newsBriefing !== undefined) next.newsBriefing = patch.newsBriefing;
    this.write(next);
    return next;
  }
}

module.exports = { SettingsStore };
