const fs = require("fs");
const os = require("os");
const path = require("path");
const { readCurrentBrowserContext } = require("../browser-companion-monitor");
const { REMOTE_ACTIONS } = require("./remote-events");
const { serializeArtifact, serializeContext, serializeTimelineEvent } = require("./remote-serializer");

function clipText(text, limit = 160) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

class RemoteDispatch {
  constructor({ session, stores, paths, environmentMonitor, getPassiveContext }) {
    this.session = session;
    this.stores = stores;
    this.paths = paths;
    this.environmentMonitor = environmentMonitor || null;
    this.getPassiveContext = getPassiveContext || (async () => ({
      frontApp: "",
      calendar: [],
      currentPage: await readCurrentBrowserContext().catch(() => null),
    }));
  }

  getCapabilities() {
    return Object.values(REMOTE_ACTIONS);
  }

  getStatus() {
    const settings = this.stores.settingsStore.get();
    const profile = this.stores.profileStore ? this.stores.profileStore.getHomeData() : null;
    const state = this.stores.stateStore ? this.stores.stateStore.getSnapshot() : null;
    return {
      deviceName: os.hostname(),
      model: settings.model,
      capabilities: this.getCapabilities(),
      understandingScore: profile ? profile.score : 0,
      relationshipSetupCompleted: Boolean(settings.relationshipSetupCompleted),
      currentState: state ? state.current : null,
      updatedAt: new Date().toISOString(),
    };
  }

  async handle(message, onStream) {
    const action = this._resolveAction(message);
    const payload = (message && message.payload) || {};
    if (!action) throw new Error("Missing remote action");

    if (action === REMOTE_ACTIONS.CHAT_SEND) {
      return this._handleChat(payload, onStream);
    }
    if (action === REMOTE_ACTIONS.TIMELINE_TODAY) {
      return this._handleTodayTimeline(payload);
    }
    if (action === REMOTE_ACTIONS.CONTEXT_CURRENT) {
      return this._handleCurrentContext();
    }
    if (action === REMOTE_ACTIONS.ARTIFACT_RECALL) {
      return this._handleArtifactRecall(payload);
    }
    if (action === REMOTE_ACTIONS.MEDIA_DOWNLOAD) {
      return this._handleMediaDownload(payload);
    }

    throw new Error(`Unsupported remote action: ${action}`);
  }

  _resolveAction(message) {
    if (!message || typeof message !== "object") return "";
    if (message.action) return message.action;
    if (message.type === "chat.request") return REMOTE_ACTIONS.CHAT_SEND;
    if (message.type === "job.request") return message.action || "";
    return "";
  }

  _normalizeImages(images) {
    if (!Array.isArray(images) || images.length === 0) return [];
    return images.map((img) => ({
      mediaType: img.mediaType || img.mimeType || "image/jpeg",
      base64: img.base64 || img.data || "",
      filename: img.filename || "",
    })).filter((img) => img.base64);
  }

  async _handleChat(payload, onStream) {
    const passiveContext = await this.getPassiveContext().catch(() => ({
      frontApp: "",
      calendar: [],
      currentPage: null,
    }));

    const reply = await this._captureChatReply({
      message: payload.message || "",
      model: payload.model,
      images: this._normalizeImages(payload.images),
      passiveContext,
    }, onStream);

    return {
      action: REMOTE_ACTIONS.CHAT_SEND,
      reply: reply.text,
      files: reply.files && reply.files.length > 0 ? reply.files : undefined,
      usage: reply.usage,
      state: this.stores.stateStore ? this.stores.stateStore.getSnapshot().current : null,
      passiveContext: serializeContext({
        ...passiveContext,
        environmentSnapshot: this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null,
        activeTodos: this.stores.todoStore ? this.stores.todoStore.list().slice(0, 6) : [],
      }),
    };
  }

  _fileToBase64(event) {
    if (!event || !event.filename) return null;
    try {
      const filePath = event.url
        ? decodeURIComponent(event.url.replace(/^file:\/\//, ""))
        : path.join(this.paths.sharedDir, event.filename);
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      // Skip files larger than 10MB to avoid bloating the WebSocket message
      if (stat.size > 10 * 1024 * 1024) return null;
      const ext = path.extname(event.filename).toLowerCase();
      const mimeMap = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
      const mimeType = mimeMap[ext] || "";
      const data = fs.readFileSync(filePath).toString("base64");
      return {
        filename: event.filename,
        fileType: event.fileType || "image",
        size: event.size || "",
        sizeBytes: event.sizeBytes || stat.size,
        mimeType: mimeType || undefined,
        data: mimeType ? data : undefined,
      };
    } catch (_) {
      return null;
    }
  }

  async _captureChatReply(payload, onStream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const files = [];
      let latestUsage = null;
      let finished = false;
      let inFinalStream = false;
      let toolRoundSeen = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Remote chat timed out"));
      }, 5 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.session.off("event", onEvent);
      };

      const onEvent = (event) => {
        if (finished || !event || typeof event !== "object") return;
        if (event.type === "phase" && event.label === "正在处理") {
          toolRoundSeen = true;
          inFinalStream = false;
          return;
        }
        if (event.type === "thinking" && toolRoundSeen) {
          inFinalStream = true;
          return;
        }
        if (event.type === "stream" && typeof event.text === "string") {
          chunks.push(event.text);
          // Only forward stream text from the final round (after all tool use)
          // or if no tools were used at all
          if (typeof onStream === "function" && (inFinalStream || !toolRoundSeen)) {
            onStream(event.text);
          }
          return;
        }
        if (event.type === "file") {
          const serialized = this._fileToBase64(event);
          if (serialized) files.push(serialized);
          return;
        }
        if (event.type === "usage") {
          latestUsage = {
            input_tokens: event.input_tokens || 0,
            output_tokens: event.output_tokens || 0,
            total_cost: event.total_cost || "0.0000",
          };
          return;
        }
        if (event.type === "error") {
          finished = true;
          cleanup();
          reject(new Error(event.text || "Remote chat failed"));
          return;
        }
        // Note: stream_end fires multiple times when tools are used,
        // so we do NOT resolve here. We resolve when sendMessage completes.
      };

      this.session.on("event", onEvent);
      Promise.resolve(this.session.sendMessage(payload))
        .then(() => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({
            text: chunks.join(""),
            files,
            usage: latestUsage,
          });
        })
        .catch((error) => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(error);
        });
    });
  }

  async _handleTodayTimeline(payload) {
    const limit = Math.max(1, Math.min(Number(payload.limit) || 10, 30));
    const timeline = this.stores.memoryStore.getTodayTimeline(limit).map(serializeTimelineEvent).filter(Boolean);
    const todos = (this.stores.todoStore ? this.stores.todoStore.listAll() : [])
      .filter((item) => this._isToday(item.dueDate || item.expiresAt || item.created))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        title: item.title,
        detail: item.detail || "",
        dueDate: item.dueDate || "",
        expiresAt: item.expiresAt || "",
        done: Boolean(item.done),
      }));

    return {
      action: REMOTE_ACTIONS.TIMELINE_TODAY,
      timeline,
      todos,
    };
  }

  async _handleCurrentContext() {
    const passiveContext = await this.getPassiveContext().catch(() => ({
      frontApp: "",
      calendar: [],
      currentPage: null,
    }));
    return {
      action: REMOTE_ACTIONS.CONTEXT_CURRENT,
      context: serializeContext({
        ...passiveContext,
        environmentSnapshot: this.environmentMonitor ? this.environmentMonitor.getSnapshot() : null,
        activeTodos: this.stores.todoStore ? this.stores.todoStore.list().slice(0, 6) : [],
      }),
    };
  }

  async _handleArtifactRecall(payload) {
    const query = String(payload.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(payload.limit) || 8, 20));
    let artifacts = this.stores.memoryStore.getArtifacts(limit * 3);
    if (query) {
      artifacts = artifacts.filter((memory) => {
        const haystacks = [
          memory.key,
          memory.value,
          memory.meta && memory.meta.filename,
          memory.meta && memory.meta.origin,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());
        return haystacks.some((value) => value.includes(query));
      });
    }

    return {
      action: REMOTE_ACTIONS.ARTIFACT_RECALL,
      artifacts: artifacts
        .slice(0, limit)
        .map((memory) => serializeArtifact(memory, this.paths.sharedDir))
        .filter(Boolean),
    };
  }

  async _handleMediaDownload(payload) {
    const url = String(payload.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("Invalid media URL");

    const block = {
      id: `remote_download_${Date.now()}`,
      name: "download_media",
      input: {
        url,
        format: payload.format || "video",
        quality: payload.quality || "best",
      },
    };

    const result = await this.session.tools.execute(block, this.session.activeProcesses);
    if (result && result.is_error) {
      throw new Error(result.content || "Media download failed");
    }

    const match = String(result && result.content || "").match(/Downloaded:\s*(.+)$/i);
    const filename = match ? match[1].trim() : "";
    const artifactMemory = filename
      ? this.stores.memoryStore.getArtifacts(12).find((memory) => memory.meta && memory.meta.filename === filename)
      : null;

    return {
      action: REMOTE_ACTIONS.MEDIA_DOWNLOAD,
      result: clipText(result && result.content ? result.content : "完成下载", 240),
      artifact: artifactMemory ? serializeArtifact(artifactMemory, this.paths.sharedDir) : null,
    };
  }

  _isToday(value) {
    if (!value) return false;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    );
  }
}

module.exports = { RemoteDispatch };
