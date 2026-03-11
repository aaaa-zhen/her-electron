const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ipcMain, clipboard } = require("electron");
const { safePath, toFileUrl } = require("../core/tools/helpers");
const { readCurrentBrowserContext } = require("../core/browser-companion-monitor");
const { readFrontApp, readCalendarEvents } = require("./context-reader");
const { createAnthropicClient } = require("../core/chat/anthropic-client");

const QRCode = require("qrcode");
const DEFAULT_RELAY_URL = "ws://43.134.52.155:3939";

function registerIpc({ session, getMainWindow, paths, stores, getDeviceAgent }) {
  let contextCache = { calendar: [], clipboard: "", frontApp: "", currentPage: null };
  let contextCacheUpdatedAt = 0;
  let contextRefreshPromise = null;

  async function refreshContextCache(force = false) {
    const now = Date.now();
    if (!force && contextRefreshPromise) return contextRefreshPromise;
    if (!force && now - contextCacheUpdatedAt < 15000 && contextCacheUpdatedAt !== 0) return contextCache;

    contextRefreshPromise = (async () => {
      const [frontApp, calendar, currentPage] = await Promise.all([
        readFrontApp(),
        readCalendarEvents(),
        readCurrentBrowserContext().catch(() => null),
      ]);
      let clipboardText = "";
      try {
        const text = clipboard.readText().trim();
        if (text.length > 5 && text.length < 500) clipboardText = text;
      } catch (_) {}

      contextCache = {
        calendar,
        clipboard: clipboardText,
        frontApp,
        currentPage,
      };
      contextCacheUpdatedAt = Date.now();
      return contextCache;
    })();

    try {
      return await contextRefreshPromise;
    } finally {
      contextRefreshPromise = null;
    }
  }

  session.on("event", (event) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("her:event", event);
    }
  });

  ipcMain.handle("her:bootstrap", () => session.getBootstrap());

  ipcMain.handle("her:save-relationship-profile", (_event, payload) => session.saveRelationshipProfile(payload || {}));

  ipcMain.handle("her:save-api-key", (_event, apiKey) => {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) throw new Error("API Key is required");
    stores.settingsStore.update({ apiKey: apiKey.replace(/\s+/g, "") });
    return { ok: true };
  });

  ipcMain.handle("her:get-settings", () => {
    const s = stores.settingsStore.get();
    return {
      apiKey: s.apiKey ? `${s.apiKey.slice(0, 6)}...${s.apiKey.slice(-4)}` : "",
      baseURL: s.baseURL || "",
      model: s.model || "",
    };
  });

  ipcMain.handle("her:save-settings", async (_event, patch) => {
    const update = {};
    if (patch.apiKey && !patch.apiKey.includes("...")) update.apiKey = patch.apiKey.replace(/\s+/g, "");
    if (patch.baseURL !== undefined) update.baseURL = patch.baseURL.trim();
    if (patch.model !== undefined) update.model = patch.model.trim();
    stores.settingsStore.update(update);

    // Test API connectivity after saving
    try {
      const client = createAnthropicClient(stores.settingsStore);
      const settings = stores.settingsStore.get();
      const model = settings.model || "claude-sonnet-4-6";
      const res = await client.messages.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true, connected: true };
    } catch (err) {
      const msg = err.message || String(err);
      return { ok: true, connected: false, error: msg.slice(0, 200) };
    }
  });

  ipcMain.handle("her:save-news-briefing", (_event, payload) => {
    stores.settingsStore.update({ newsBriefing: payload || null });
    // Emit event so main process can re-setup cron
    session.emit("event", { type: "news_briefing_updated" });
    return stores.settingsStore.get().newsBriefing;
  });

  ipcMain.handle("her:get-news-briefing", () => {
    return stores.settingsStore.get().newsBriefing;
  });

  ipcMain.on("her:send-message", (_event, payload) => {
    session.sendMessage(payload);
  });

  ipcMain.on("her:cancel", () => {
    session.cancel();
  });

  ipcMain.handle("her:upload-file", (_event, payload) => {
    const cleanName = (payload.name || "upload.bin").replace(/\.\.\//g, "").replace(/\0/g, "");
    const targetPath = safePath(paths.sharedDir, cleanName);
    if (!targetPath) throw new Error("Invalid filename");

    const finalPath = fs.existsSync(targetPath)
      ? safePath(paths.sharedDir, `${Date.now()}_${cleanName}`)
      : targetPath;

    const buffer = Buffer.from(payload.data);
    fs.writeFileSync(finalPath, buffer);
    if (session && typeof session.recordArtifact === "function") {
      session.recordArtifact({
        filename: path.basename(finalPath),
        kind: (payload.type || "").startsWith("image/")
          ? "image"
          : (payload.type || "").startsWith("video/")
            ? "video"
            : (payload.type || "").startsWith("audio/")
              ? "audio"
              : "file",
        origin: "user_upload",
        detail: `用户上传到共享目录的文件：${path.basename(finalPath)}`,
      });
    }
    return {
      filename: path.basename(finalPath),
      size: buffer.length,
    };
  });

  ipcMain.handle("her:toggle-pin", () => {
    const win = getMainWindow();
    if (!win) return false;
    const pinned = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(pinned);
    win.webContents.send("her:event", { type: "pin-changed", pinned });
    return pinned;
  });

  ipcMain.handle("her:get-todos", () => {
    if (stores && stores.todoStore) return stores.todoStore.list();
    return [];
  });

  ipcMain.handle("her:get-context", async () => {
    if (contextCacheUpdatedAt === 0) return refreshContextCache(true);
    refreshContextCache(false).catch(() => {});
    return contextCache;
  });

  ipcMain.handle("her:shared-file-url", (_event, filename) => {
    const filePath = safePath(paths.sharedDir, filename);
    if (!filePath || !fs.existsSync(filePath)) throw new Error("File not found");
    return toFileUrl(filePath);
  });

  ipcMain.handle("her:get-profile", () => {
    if (stores && stores.profileStore) return stores.profileStore.getHomeData();
    return { score: 0, totalObservations: 0, firstSeen: null, topTraits: [] };
  });

  ipcMain.handle("her:get-browser-digest", () => {
    if (stores && stores.browserHistoryStore) return stores.browserHistoryStore.getHomeData();
    return { lastImportedAt: null, lastError: "", summary: "", topThreads: [], topDomains: [], sources: [] };
  });

  ipcMain.handle("her:get-remote-config", () => {
    const settings = stores && stores.settingsStore ? stores.settingsStore.get() : {};
    return {
      remoteAgentEnabled: Boolean(settings.remoteAgentEnabled),
      remoteRelayUrl: settings.remoteRelayUrl || "",
      remoteDeviceToken: settings.remoteDeviceToken || "",
    };
  });

  ipcMain.handle("her:save-remote-config", (_event, payload) => {
    if (!stores || !stores.settingsStore) throw new Error("Settings store unavailable");
    const next = stores.settingsStore.update({
      remoteAgentEnabled: payload && payload.remoteAgentEnabled,
      remoteRelayUrl: payload && payload.remoteRelayUrl,
      remoteDeviceToken: payload && payload.remoteDeviceToken,
    });
    return {
      remoteAgentEnabled: Boolean(next.remoteAgentEnabled),
      remoteRelayUrl: next.remoteRelayUrl || "",
      remoteDeviceToken: next.remoteDeviceToken || "",
    };
  });

  // ── Pairing: generate token pair, register with relay, return QR data ──

  ipcMain.handle("her:generate-pair", async (_event, payload) => {
    const relayBase = (payload && payload.relayUrl) || DEFAULT_RELAY_URL;
    const httpBase = relayBase.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const agentToken = crypto.randomBytes(32).toString("hex");
    const clientToken = crypto.randomBytes(32).toString("hex");

    // Register with relay server
    const { net } = require("electron");
    const res = await net.fetch(`${httpBase}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentToken, clientToken }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay registration failed: ${res.status} ${text}`);
    }
    const result = await res.json();

    // Save to settings and auto-enable
    const os = require("os");
    stores.settingsStore.update({
      remoteAgentEnabled: true,
      remoteRelayUrl: `${relayBase}/ws/agent`,
      remoteDeviceToken: agentToken,
      remoteClientToken: clientToken,
      remotePairId: result.pairId,
    });

    // Restart DeviceAgent with new config
    const agent = getDeviceAgent && getDeviceAgent();
    if (agent) {
      agent.stop();
      agent.start();
    }

    const deviceName = os.hostname();
    const qrPayload = JSON.stringify({
      relay: `${relayBase}/ws/client`,
      token: clientToken,
      name: deviceName,
    });
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    return {
      pairId: result.pairId,
      qrData: qrPayload,
      qrImage: qrDataUrl,
      deviceName,
      clientToken,
    };
  });

  ipcMain.handle("her:revoke-pair", async () => {
    const settings = stores.settingsStore.get();
    const agentToken = settings.remoteDeviceToken;
    if (!agentToken) return { ok: true };

    const relayUrl = settings.remoteRelayUrl || "";
    const relayBase = relayUrl.replace(/\/ws\/agent$/, "");
    const httpBase = relayBase.replace(/^wss:/, "https:").replace(/^ws:/, "http:");

    // Stop agent first
    const agent = getDeviceAgent && getDeviceAgent();
    if (agent) agent.stop();

    // Revoke on server (best effort)
    try {
      const { net } = require("electron");
      await net.fetch(`${httpBase}/api/pair`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentToken }),
      });
    } catch (_) {}

    stores.settingsStore.update({
      remoteAgentEnabled: false,
      remoteRelayUrl: "",
      remoteDeviceToken: "",
      remoteClientToken: "",
      remotePairId: "",
    });

    return { ok: true };
  });

  ipcMain.handle("her:get-pair-status", () => {
    const settings = stores.settingsStore.get();
    const agent = getDeviceAgent && getDeviceAgent();
    return {
      paired: Boolean(settings.remotePairId),
      pairId: settings.remotePairId || "",
      connected: agent ? agent.getStatus().connected : false,
      deviceName: require("os").hostname(),
      relayUrl: settings.remoteRelayUrl || "",
      clientToken: settings.remoteClientToken || "",
    };
  });
}

module.exports = { registerIpc };
