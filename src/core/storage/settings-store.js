const path = require("path");
const { JsonFileStore } = require("./json-file");
const { DEFAULT_MODEL } = require("../shared/constants");

class SettingsStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "settings.json"), () => ({}));
  }

  get() {
    const settings = this.read();
    return {
      baseURL: "https://api.anthropic.com",
      model: DEFAULT_MODEL,
      relationshipProfile: null,
      relationshipSetupCompleted: false,
      browserHistoryEnabled: true,
      browserHistoryScanHour: 4,
      remoteAgentEnabled: false,
      remoteRelayUrl: "",
      remoteDeviceToken: "",
      newsBriefing: null,
      ...settings,
    };
  }

  update(patch) {
    const next = { ...this.get() };
    if (patch.apiKey !== undefined && patch.apiKey !== "") next.apiKey = patch.apiKey;
    if (patch.baseURL !== undefined) next.baseURL = patch.baseURL;
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.relationshipProfile !== undefined) next.relationshipProfile = patch.relationshipProfile;
    if (patch.relationshipSetupCompleted !== undefined) next.relationshipSetupCompleted = Boolean(patch.relationshipSetupCompleted);
    if (patch.browserHistoryEnabled !== undefined) next.browserHistoryEnabled = Boolean(patch.browserHistoryEnabled);
    if (patch.browserHistoryScanHour !== undefined) next.browserHistoryScanHour = patch.browserHistoryScanHour;
    if (patch.remoteAgentEnabled !== undefined) next.remoteAgentEnabled = Boolean(patch.remoteAgentEnabled);
    if (patch.remoteRelayUrl !== undefined) next.remoteRelayUrl = patch.remoteRelayUrl;
    if (patch.remoteDeviceToken !== undefined) next.remoteDeviceToken = patch.remoteDeviceToken;
    if (patch.newsBriefing !== undefined) next.newsBriefing = patch.newsBriefing;
    this.write(next);
    return next;
  }
}

module.exports = { SettingsStore };
