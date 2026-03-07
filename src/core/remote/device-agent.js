const EventEmitter = require("events");
const os = require("os");
const WebSocket = require("ws");
const { REMOTE_MESSAGE_TYPES } = require("./remote-events");

const BASE_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;

class DeviceAgent extends EventEmitter {
  constructor({ settingsStore, dispatch }) {
    super();
    this.settingsStore = settingsStore;
    this.dispatch = dispatch;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectDelay = BASE_RECONNECT_MS;
    this.shouldRun = false;
  }

  start() {
    this.shouldRun = true;
    this._connectIfConfigured();
  }

  stop() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) {}
    }
    this.socket = null;
  }

  getStatus() {
    return {
      connected: Boolean(this.socket && this.socket.readyState === WebSocket.OPEN),
      relayUrl: this.settingsStore.get().remoteRelayUrl || "",
      enabled: Boolean(this.settingsStore.get().remoteAgentEnabled),
      reconnectDelayMs: this.reconnectDelay,
    };
  }

  _connectIfConfigured() {
    if (!this.shouldRun || this.socket) return;
    const settings = this.settingsStore.get();
    if (!settings.remoteAgentEnabled || !settings.remoteRelayUrl || !settings.remoteDeviceToken) return;

    const headers = {
      authorization: `Bearer ${settings.remoteDeviceToken}`,
      "x-her-device-name": os.hostname(),
    };

    const socket = new WebSocket(settings.remoteRelayUrl, { headers });
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectDelay = BASE_RECONNECT_MS;
      this._send({
        type: REMOTE_MESSAGE_TYPES.AGENT_HELLO,
        payload: {
          app: "Her",
          deviceName: os.hostname(),
          status: this.dispatch.getStatus(),
        },
      });
      this._sendStatus();
      this.emit("connected");
    });

    socket.on("message", (raw) => {
      this._handleMessage(raw).catch((error) => {
        this._send({
          type: REMOTE_MESSAGE_TYPES.JOB_ERROR,
          requestId: "",
          error: error.message || "Remote dispatch failed",
        });
      });
    });

    socket.on("close", () => {
      this.emit("disconnected");
      this.socket = null;
      this._scheduleReconnect();
    });

    socket.on("error", () => {
      try {
        socket.close();
      } catch (_) {}
    });
  }

  _scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectIfConfigured();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
  }

  _sendStatus() {
    this._send({
      type: REMOTE_MESSAGE_TYPES.AGENT_STATUS,
      payload: this.dispatch.getStatus(),
    });
  }

  _send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (_) {}
  }

  async _handleMessage(raw) {
    const text = String(raw || "");
    if (!text) return;
    let message = null;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === REMOTE_MESSAGE_TYPES.AGENT_PING) {
      this._send({ type: REMOTE_MESSAGE_TYPES.AGENT_PONG, at: new Date().toISOString() });
      return;
    }

    if (message.type === REMOTE_MESSAGE_TYPES.AGENT_REFRESH_STATUS) {
      this._sendStatus();
      return;
    }

    if (message.type !== REMOTE_MESSAGE_TYPES.CHAT_REQUEST && message.type !== REMOTE_MESSAGE_TYPES.JOB_REQUEST) {
      return;
    }

    const requestId = message.requestId || "";
    const onStream = message.type === REMOTE_MESSAGE_TYPES.CHAT_REQUEST
      ? (text) => this._send({ type: REMOTE_MESSAGE_TYPES.CHAT_STREAM, requestId, text })
      : null;
    try {
      const result = await this.dispatch.handle(message, onStream);
      this._send({
        type: message.type === REMOTE_MESSAGE_TYPES.CHAT_REQUEST
          ? REMOTE_MESSAGE_TYPES.CHAT_RESPONSE
          : REMOTE_MESSAGE_TYPES.JOB_RESULT,
        requestId,
        payload: result,
      });
    } catch (error) {
      this._send({
        type: REMOTE_MESSAGE_TYPES.JOB_ERROR,
        requestId,
        error: error.message || "Remote request failed",
      });
    }
  }
}

module.exports = { DeviceAgent };
