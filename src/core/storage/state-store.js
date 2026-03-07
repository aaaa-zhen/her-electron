const path = require("path");
const { JsonFileStore } = require("./json-file");

const MAX_SIGNALS = 24;

function now() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 1,
    updatedAt: null,
    current: {
      mode: "general",
      intent: "ask_fact",
      emotionalTone: "neutral",
      energy: "medium",
      urgency: "low",
      focusThread: "",
      responseStyle: "balanced",
      shouldReferenceContext: false,
      shouldUseTools: false,
      shouldBeBrief: false,
      needs: [],
      confidence: 0,
      summary: "",
    },
    recentSignals: [],
  };
}

class StateStore extends JsonFileStore {
  constructor(dataDir) {
    super(path.join(dataDir, "state-snapshot.json"), defaultState);
  }

  getSnapshot() {
    const state = this.read();
    if (!state || !state.current) return defaultState();
    return state;
  }

  updateCurrent(nextCurrent, signals = []) {
    if (!nextCurrent || typeof nextCurrent !== "object") return this.getSnapshot();
    const state = this.getSnapshot();
    state.updatedAt = now();
    state.current = {
      ...state.current,
      ...nextCurrent,
    };

    const stampedSignals = (Array.isArray(signals) ? signals : [])
      .filter((signal) => signal && signal.signal)
      .map((signal) => ({
        ...signal,
        at: signal.at || now(),
      }));

    if (stampedSignals.length > 0) {
      state.recentSignals = [...stampedSignals, ...(state.recentSignals || [])].slice(0, MAX_SIGNALS);
    }

    this.write(state);
    return state;
  }

  getPromptSummary() {
    const state = this.getSnapshot().current;
    const lines = [];
    if (state.mode) lines.push(`- mode: ${state.mode}`);
    if (state.intent) lines.push(`- likely intent: ${state.intent}`);
    if (state.emotionalTone) lines.push(`- emotional tone: ${state.emotionalTone}`);
    if (state.energy) lines.push(`- energy: ${state.energy}`);
    if (state.urgency) lines.push(`- urgency: ${state.urgency}`);
    if (state.focusThread) lines.push(`- focus thread: ${state.focusThread}`);
    if (state.responseStyle) lines.push(`- preferred response style this turn: ${state.responseStyle}`);
    if (Array.isArray(state.needs) && state.needs.length > 0) {
      lines.push(`- likely needs: ${state.needs.join(", ")}`);
    }
    if (state.summary) lines.push(`- summary: ${state.summary}`);
    return lines.join("\n");
  }
}

module.exports = { StateStore };
