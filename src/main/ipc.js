const fs = require("fs");
const path = require("path");
const { ipcMain, clipboard, shell, app } = require("electron");
const { safePath, toFileUrl } = require("../core/tools/helpers");
const { readFrontApp, readCalendarEvents } = require("./context-reader");
const { createClient } = require("../core/chat/anthropic-client");

function registerIpc({ session, getMainWindow, paths, stores }) {
  let contextCache = { calendar: [], clipboard: "", frontApp: "" };
  let contextCacheUpdatedAt = 0;
  let contextRefreshPromise = null;

  async function refreshContextCache(force = false) {
    const now = Date.now();
    if (!force && contextRefreshPromise) return contextRefreshPromise;
    if (!force && now - contextCacheUpdatedAt < 15000 && contextCacheUpdatedAt !== 0) return contextCache;

    contextRefreshPromise = (async () => {
      const [frontApp, calendar] = await Promise.all([
        readFrontApp(),
        readCalendarEvents(),
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
    const mask = (k) => k ? `${k.slice(0, 6)}...${k.slice(-4)}` : "";
    return {
      apiKey: mask(s.apiKey),
      searchApiKey: mask(s.searchApiKey),
      baseURL: s.baseURL || "",
      model: s.model || "",
    };
  });

  ipcMain.handle("her:save-settings", async (_event, patch) => {
    const update = {};
    // API Key: "__clear__" means user cleared the field → reset to use built-in default
    if (patch.apiKey === "__clear__") {
      update.apiKey = "";
    } else if (patch.apiKey && !patch.apiKey.includes("...")) {
      update.apiKey = patch.apiKey.replace(/\s+/g, "");
    }
    // Search API Key
    if (patch.searchApiKey === "__clear__") {
      update.searchApiKey = "";
    } else if (patch.searchApiKey && !patch.searchApiKey.includes("...")) {
      update.searchApiKey = patch.searchApiKey.replace(/\s+/g, "");
    }
    if (patch.baseURL !== undefined) update.baseURL = patch.baseURL.trim();
    if (patch.model !== undefined) update.model = patch.model.trim();
    stores.settingsStore.update(update);

    // Test API connectivity after saving
    try {
      const settings = stores.settingsStore.get();
      const model = settings.model || require("../core/shared/constants").DEFAULT_MODEL;
      const client = createClient(stores.settingsStore);
      await client.chat.completions.create({
        model,
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true, connected: true };
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      const raw = err.message || String(err);
      let friendly;
      if (status === 403) {
        friendly = "当前 API Key 分组可能不支持所选模型，请尝试切换模型或更换 Key";
      } else if (status === 401) {
        friendly = "API Key 无效或已过期，请检查后重试";
      } else if (status === 429) {
        friendly = "请求过于频繁，请稍后再试";
      } else if (status === 503 || status === 502) {
        friendly = "API 服务暂时不可用，请稍后重试";
      } else if (raw.includes("fetch failed") || raw.includes("ECONNREFUSED") || raw.includes("ENOTFOUND")) {
        friendly = "无法连接到 API 服务器，请检查网络或 Base URL";
      } else {
        friendly = raw.slice(0, 200);
      }
      return { ok: true, connected: false, error: friendly };
    }
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

  // --- Update check ---
  const UPDATE_SERVER = "http://43.134.52.155";

  ipcMain.handle("her:check-update", async () => {
    try {
      const currentVersion = app.getVersion();
      const res = await fetch(`${UPDATE_SERVER}/version.json?t=${Date.now()}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { hasUpdate: false, currentVersion, error: "服务器无响应" };
      const data = await res.json();
      const latestVersion = data.version;
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        changelog: data.changelog || "",
        downloadUrl: process.platform === "darwin"
          ? (process.arch === "arm64" ? data.dmgArm64 : data.dmgIntel)
          : data.exe,
      };
    } catch (err) {
      return { hasUpdate: false, currentVersion: app.getVersion(), error: err.message };
    }
  });

  ipcMain.handle("her:open-url", (_event, url) => {
    if (typeof url === "string" && url.startsWith("http")) shell.openExternal(url);
  });
}

function compareVersions(a, b) {
  const pa = (a || "0").split(".").map(Number);
  const pb = (b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ── WeChat IPC ──

function registerWeixinIpc(weixinService) {
  if (!weixinService) return;

  ipcMain.handle("her:weixin-status", () => weixinService.getStatus());

  ipcMain.handle("her:weixin-login", async () => {
    return await weixinService.startLogin();
  });

  ipcMain.handle("her:weixin-disconnect", () => {
    weixinService.disconnect();
    return { ok: true };
  });
}

module.exports = { registerIpc, registerWeixinIpc };
