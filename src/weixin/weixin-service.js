/**
 * WeChat Bridge Service — runs inside Electron main process.
 *
 * Manages login (QR code), message loop, and per-user ChatSession isolation.
 * Uses weixin-agent-sdk's low-level APIs directly instead of the high-level
 * login()/start() so we can capture QR code URLs for the Electron UI.
 */

const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");

const { ChatSession } = require("../core/chat/chat-session");
const { SettingsStore } = require("../core/storage/settings-store");
const { ConversationStore } = require("../core/storage/conversation-store");
const { MemoryStore } = require("../core/storage/memory-store");
const { ScheduleStore } = require("../core/storage/schedule-store");
const { TodoStore } = require("../core/storage/todo-store");
const { ProfileStore } = require("../core/storage/profile-store");
const { StateStore } = require("../core/storage/state-store");
const { SummaryDagStore } = require("../core/storage/summary-dag-store");
const { ScheduleService } = require("../core/chat/schedule-service");
const { execAsync } = require("../core/tools/process-utils");
const { createAnthropicClient } = require("../core/chat/anthropic-client");

// weixin-agent-sdk is ESM — we use dynamic import()
let sdkModule = null;
async function loadSdk() {
  if (!sdkModule) {
    sdkModule = await import("weixin-agent-sdk");
  }
  return sdkModule;
}

const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
const QR_POLL_TIMEOUT_MS = 35000;

/** Fetch a QR code from WeChat API */
async function fetchQrCode() {
  const url = `${WEIXIN_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return await res.json(); // { qrcode, qrcode_img_content }
}

/** Poll QR code scan status */
async function pollQrStatus(qrcode) {
  const url = `${WEIXIN_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    return await res.json(); // { status, bot_token, ilink_bot_id, baseurl, ilink_user_id }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

const SESSION_TTL_MS = 30 * 60 * 1000;

class WeixinService extends EventEmitter {
  constructor({ dataDir, sharedDir }) {
    super();
    this.mainDataDir = dataDir;
    this.sharedDir = sharedDir;
    this.weixinDataDir = path.join(dataDir, "weixin");
    this.sessions = new Map();
    this.abortController = null;
    this.status = "disconnected"; // disconnected | qr_pending | connected
    this.accountId = null;

    // Cleanup timer
    this._cleanupTimer = setInterval(() => this._cleanupIdleSessions(), 5 * 60 * 1000);
  }

  // ── Login ──────────────────────────────────────────────────────────────

  async startLogin() {
    if (this.status === "qr_pending") return { success: false, error: "登录进行中" };

    this.status = "qr_pending";
    this.emit("status", { status: "qr_pending" });

    try {
      // Step 1: Get QR code from WeChat API
      console.log("[WeChat] Fetching QR code...");
      const qrData = await fetchQrCode();
      const qrUrl = qrData.qrcode_img_content;
      const qrToken = qrData.qrcode;

      if (!qrUrl) throw new Error("No QR code URL received");

      // Send QR URL to UI immediately
      console.log("[WeChat] QR code ready, waiting for scan...");
      this.emit("status", { status: "qr_pending", qrUrl });

      // Step 2: Poll for scan confirmation
      const deadline = Date.now() + 480000; // 8 min timeout
      let maxRefresh = 3;
      let currentQrToken = qrToken;

      while (Date.now() < deadline) {
        const result = await pollQrStatus(currentQrToken);

        switch (result.status) {
          case "wait":
            break;
          case "scaned":
            console.log("[WeChat] QR scanned, waiting for confirmation...");
            this.emit("status", { status: "qr_scanned" });
            break;
          case "expired":
            maxRefresh--;
            if (maxRefresh <= 0) throw new Error("二维码多次过期，请重试");
            console.log("[WeChat] QR expired, refreshing...");
            const newQr = await fetchQrCode();
            currentQrToken = newQr.qrcode;
            this.emit("status", { status: "qr_pending", qrUrl: newQr.qrcode_img_content });
            break;
          case "confirmed":
            if (!result.ilink_bot_id) throw new Error("登录失败：未返回 bot ID");

            // Step 3: Save credentials via SDK's login for persistence,
            // then start monitor
            const sdk = await loadSdk();
            const accountId = result.ilink_bot_id;

            // Persist credentials so SDK's start() can find them
            await this._persistAccount(accountId, result.bot_token, result.baseurl);

            this.accountId = accountId;
            this.status = "connected";
            this.emit("status", { status: "connected", accountId });
            console.log(`[WeChat] Connected! accountId=${accountId}`);

            // Start message loop in background
            this._startMonitor(sdk);
            return { success: true, accountId };
        }

        await new Promise((r) => setTimeout(r, 1000));
      }

      throw new Error("登录超时，请重试");
    } catch (err) {
      console.error("[WeChat] Login failed:", err.message);
      this.status = "disconnected";
      this.emit("status", { status: "disconnected", error: err.message });
      return { success: false, error: err.message };
    }
  }

  /** Persist WeChat credentials so SDK's start() can find them */
  async _persistAccount(accountId, token, baseUrl) {
    const os = require("os");
    const stateDir = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts");
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    // Save account credentials
    const accountFile = path.join(stateDir, `${accountId}.json`);
    const existing = fs.existsSync(accountFile) ? JSON.parse(fs.readFileSync(accountFile, "utf-8")) : {};
    existing.token = token;
    if (baseUrl) existing.baseUrl = baseUrl;
    fs.writeFileSync(accountFile, JSON.stringify(existing, null, 2));

    // Register in accounts list
    const listFile = path.join(stateDir, "..", "accounts.json");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(listFile, "utf-8")); } catch {}
    if (!list.includes(accountId)) {
      list.unshift(accountId);
      fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
    }
  }

  // ── Monitor (message loop) ────────────────────────────────────────────

  async _startMonitor(sdk) {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    const agent = this._createAgent();

    try {
      await sdk.start(agent, {
        accountId: this.accountId,
        abortSignal: this.abortController.signal,
        log: (msg) => {
          console.log(`[WeChat] ${msg}`);
          this.emit("log", msg);
        },
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[WeChat] Monitor error:", err.message);
        this.status = "disconnected";
        this.emit("status", { status: "disconnected", error: err.message });
      }
    }
  }

  // ── Agent implementation ──────────────────────────────────────────────

  _createAgent() {
    return {
      chat: async (request) => {
        const { conversationId, text, media } = request;
        const session = this._getOrCreateSession(conversationId);

        let messageText = text || "";
        const imagePaths = [];

        if (media) {
          if (media.type === "image") {
            imagePaths.push(media.filePath);
            if (!messageText) messageText = "[图片]";
          } else if (media.type === "audio") {
            if (!messageText) messageText = "[语音消息]";
          } else if (media.type === "video") {
            messageText += messageText ? `\n[视频: ${media.filePath}]` : `[视频: ${media.filePath}]`;
          } else if (media.type === "file") {
            messageText += messageText
              ? `\n[文件: ${media.fileName || media.filePath}]`
              : `[文件: ${media.fileName || media.filePath}]`;
          }
        }

        if (!messageText.trim()) return { text: undefined };

        // Prepend channel marker so Her knows this is from WeChat
        messageText = `[via 微信] ${messageText}`;

        try {
          console.log(`[WeChat] ${conversationId}: ${messageText.slice(0, 80)}`);
          const response = await this._chatWithHer(session, messageText, imagePaths);
          console.log(`[WeChat] Reply: ${(response.text || "").slice(0, 80)}${response.media ? " +media" : ""}`);
          return response;
        } catch (err) {
          console.error(`[WeChat] Error:`, err.message);
          return { text: `出错了: ${err.message}` };
        }
      },
    };
  }

  _chatWithHer(session, text, imagePaths = []) {
    return new Promise((resolve, reject) => {
      let responseText = "";
      let mediaFile = null;
      let errorText = null;

      const onEvent = (event) => {
        if (event.type === "stream") responseText += event.text;
        else if (event.type === "file") mediaFile = event;
        else if (event.type === "error") errorText = event.text;
      };

      session.on("event", onEvent);

      const images = imagePaths.map((filePath) => {
        const data = fs.readFileSync(filePath);
        const base64 = data.toString("base64");
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
        return { mediaType: mimeMap[ext] || "image/jpeg", base64 };
      });

      session
        .sendMessage({ message: text, images: images.length > 0 ? images : undefined })
        .then(() => {
          session.removeListener("event", onEvent);

          if (errorText && !responseText) {
            resolve({ text: `[Error] ${errorText}` });
            return;
          }

          const cleanText = responseText.trim();
          if (cleanText === "[SILENT]" || !cleanText) {
            resolve({ text: undefined });
            return;
          }

          const result = { text: cleanText };

          if (mediaFile) {
            let filePath = "";
            if (mediaFile.url && mediaFile.url.startsWith("file://")) {
              filePath = decodeURIComponent(mediaFile.url.replace("file://", ""));
            } else if (mediaFile.filename) {
              filePath = path.join(this.sharedDir, mediaFile.filename);
            }

            if (filePath && fs.existsSync(filePath)) {
              const ext = path.extname(filePath).toLowerCase();
              const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
              const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
              let mediaType = "file";
              if (imageExts.includes(ext)) mediaType = "image";
              else if (videoExts.includes(ext)) mediaType = "video";

              result.media = { type: mediaType, url: filePath, fileName: mediaFile.filename };
            }
          }

          resolve(result);
        })
        .catch((err) => {
          session.removeListener("event", onEvent);
          reject(err);
        });
    });
  }

  // ── Per-user session management ───────────────────────────────────────

  _getOrCreateSession(conversationId) {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      existing.lastActive = Date.now();
      return existing.session;
    }

    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const userDataDir = path.join(this.weixinDataDir, safeId);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const paths = { dataDir: userDataDir, sharedDir: this.sharedDir };

    const stores = {
      settingsStore: new SettingsStore(this.mainDataDir),
      conversationStore: new ConversationStore(userDataDir),
      memoryStore: new MemoryStore(userDataDir),
      scheduleStore: new ScheduleStore(userDataDir),
      todoStore: new TodoStore(userDataDir),
      profileStore: new ProfileStore(userDataDir),
      stateStore: new StateStore(userDataDir),
      summaryDagStore: new SummaryDagStore(userDataDir),
    };

    const scheduleService = new ScheduleService({
      scheduleStore: stores.scheduleStore,
      execAsync: (command, options) => execAsync(command, { cwd: this.sharedDir, ...options }),
      processScheduleOutput: null,
    });

    const session = new ChatSession({
      paths,
      stores,
      createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
      scheduleService,
    });

    this.sessions.set(conversationId, { session, lastActive: Date.now() });
    console.log(`[WeChat] New session: ${conversationId}`);
    return session;
  }

  _cleanupIdleSessions() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastActive > SESSION_TTL_MS) {
        this.sessions.delete(id);
        console.log(`[WeChat] Cleaned idle session: ${id}`);
      }
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────

  disconnect() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.status = "disconnected";
    this.accountId = null;
    this.emit("status", { status: "disconnected" });
  }

  destroy() {
    this.disconnect();
    clearInterval(this._cleanupTimer);
    this.sessions.clear();
  }

  getStatus() {
    return { status: this.status, accountId: this.accountId };
  }
}

module.exports = { WeixinService };
