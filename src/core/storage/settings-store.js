const path = require("path");
const { JsonFileStore } = require("./json-file");
const { DEFAULT_MODEL } = require("../shared/constants");

class SettingsStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "settings.json"), () => ({}));
    this._migrated = false;
  }

  /** Migrate legacy anthropicApiKey/anthropicBaseURL to unified fields (one-time). */
  _migrateIfNeeded(settings) {
    if (this._migrated) return settings;
    this._migrated = true;

    // Migrate old anthropicApiKey to apiKey
    if (settings.anthropicApiKey && !settings.apiKey) {
      settings.apiKey = settings.anthropicApiKey;
      delete settings.anthropicApiKey;
    }
    if (settings.anthropicBaseURL && !settings.baseURL) {
      settings.baseURL = settings.anthropicBaseURL;
      delete settings.anthropicBaseURL;
    }

    return settings;
  }

  get() {
    const settings = this.read();
    const merged = {
      apiKey: "",
      baseURL: "https://www.packyapi.com",
      model: DEFAULT_MODEL,
      relationshipProfile: null,
      relationshipSetupCompleted: false,
      ...settings,
    };
    return this._migrateIfNeeded(merged);
  }

  update(patch) {
    const next = { ...this.get() };
    if (patch.apiKey !== undefined) next.apiKey = patch.apiKey;
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.relationshipProfile !== undefined) next.relationshipProfile = patch.relationshipProfile;
    if (patch.relationshipSetupCompleted !== undefined) next.relationshipSetupCompleted = Boolean(patch.relationshipSetupCompleted);
    // Clean up legacy fields
    delete next.anthropicApiKey;
    delete next.anthropicBaseURL;
    this.write(next);
    return next;
  }
}

module.exports = { SettingsStore };
