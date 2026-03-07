const path = require("path");
const { JsonFileStore } = require("./json-file");

function defaultState() {
  return {
    version: 1,
    lastImportedAt: null,
    lastError: "",
    lastDigest: null,
    sources: [],
  };
}

class BrowserHistoryStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "browser-history.json"), defaultState);
  }

  getState() {
    return this.read();
  }

  saveDigest({ digest, sources = [] }) {
    const next = {
      ...this.getState(),
      lastImportedAt: new Date().toISOString(),
      lastError: "",
      lastDigest: digest,
      sources,
    };
    this.write(next);
    return next;
  }

  saveFailure(error) {
    const next = {
      ...this.getState(),
      lastImportedAt: new Date().toISOString(),
      lastError: error ? String(error) : "Unknown browser history import error",
    };
    this.write(next);
    return next;
  }

  getHomeData() {
    const state = this.getState();
    const digest = state.lastDigest || null;
    return {
      lastImportedAt: state.lastImportedAt,
      lastError: state.lastError || "",
      summary: digest ? digest.summary || "" : "",
      topThreads: digest ? digest.topThreads || [] : [],
      topDomains: digest ? digest.topDomains || [] : [],
      sources: state.sources || [],
    };
  }
}

module.exports = { BrowserHistoryStore };
