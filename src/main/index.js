const path = require("path");
const { app, dialog, nativeImage, globalShortcut, Tray, Menu, Notification } = require("electron");
const { ensureAppPaths } = require("./app-paths");
const { createMainWindow } = require("./window");
const { registerIpc } = require("./ipc");
const { SettingsStore } = require("../core/storage/settings-store");
const { ConversationStore } = require("../core/storage/conversation-store");
const { MemoryStore } = require("../core/storage/memory-store");
const { ScheduleStore } = require("../core/storage/schedule-store");
const { TodoStore } = require("../core/storage/todo-store");
const { ProfileStore } = require("../core/storage/profile-store");
const { StateStore } = require("../core/storage/state-store");
const { BrowserHistoryStore } = require("../core/storage/browser-history-store");
const { SkillStore } = require("../core/storage/skill-store");
const { SummaryDagStore } = require("../core/storage/summary-dag-store");
const { createAnthropicClient } = require("../core/chat/anthropic-client");
const { ScheduleService } = require("../core/chat/schedule-service");
const { ContextMonitor } = require("../core/context-monitor");
const { ChatSession } = require("../core/chat/chat-session");
const { BrowserCompanionMonitor } = require("../core/browser-companion-monitor");
const { BrowserHistoryEvolutionService } = require("../core/browser-history-evolution");
const { EnvironmentMonitor } = require("../core/environment-monitor");
const { AwarenessService } = require("../core/awareness-service");
const { execAsync } = require("../core/tools/process-utils");
const { readFrontApp, readCalendarEvents } = require("./context-reader");
const { DeviceAgent } = require("../core/remote/device-agent");
const { RemoteDispatch } = require("../core/remote/remote-dispatch");
const { readCurrentBrowserContext } = require("../core/browser-companion-monitor");

app.setName("Her");

// Prevent crash dialogs from uncaught errors (e.g. tesseract.js worker fetch failures)
process.on("uncaughtException", (err) => {
  console.error("[her] uncaughtException:", err.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[her] unhandledRejection:", reason);
});

// Register her:// URL scheme for Shortcuts / automation
if (process.defaultApp) {
  // Dev mode: register with path to electron
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("her", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("her");
}

// Dev mode isolation: use separate userData so dev and production can run side by side
if (process.env.HER_DEV === "1") {
  const devPath = path.join(app.getPath("appData"), "Her-Dev");
  app.setPath("userData", devPath);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const nodeCron = require("node-cron");

let mainWindow = null;
let tray = null;
let chatSession = null;
let scheduleService = null;
let contextMonitor = null;
let newsBriefingJob = null;
let browserCompanionMonitor = null;
let browserHistoryEvolutionService = null;
let environmentMonitor = null;
let awarenessService = null;
let deviceAgent = null;
let initialized = false;

function dispatchReminderNotification(event) {
  if (!event || !event.title) return;

  if (Notification.isSupported()) {
    const notification = new Notification({
      title: event.title,
      body: event.body || "",
      silent: false,
    });

    notification.on("click", () => {
      ensureWindow();
      mainWindow.show();
      mainWindow.focus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("her:event", {
          type: "context_reminder",
          reminder: event,
        });
      }
    });

    notification.show();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("her:event", {
      type: "context_reminder",
      reminder: event,
    });
  }
}

async function initializeApp() {
  if (initialized) return;
  initialized = true;

  const paths = ensureAppPaths();
  initializeApp.paths = paths;

  const stores = {
    settingsStore: new SettingsStore(paths.dataDir),
    conversationStore: new ConversationStore(paths.dataDir),
    memoryStore: new MemoryStore(paths.dataDir),
    scheduleStore: new ScheduleStore(paths.dataDir),
    todoStore: new TodoStore(paths.dataDir),
    profileStore: new ProfileStore(paths.dataDir),
    stateStore: new StateStore(paths.dataDir),
    browserHistoryStore: new BrowserHistoryStore(paths.dataDir),
    skillStore: new SkillStore(paths.dataDir),
    summaryDagStore: new SummaryDagStore(paths.dataDir),
  };

  scheduleService = new ScheduleService({
    scheduleStore: stores.scheduleStore,
    execAsync: (command, options) => execAsync(command, { cwd: paths.sharedDir, ...options }),
    processScheduleOutput: null,
  });

  contextMonitor = new ContextMonitor({ todoStore: stores.todoStore });
  contextMonitor.on("notification", (event) => {
    if (stores.memoryStore && typeof stores.memoryStore.saveTimelineEvent === "function" && event && event.title) {
      stores.memoryStore.saveTimelineEvent({
        key: `timeline:${event.kind || "event"}:${event.meta && event.meta.id ? event.meta.id : event.title}`,
        title: event.title,
        at: (event.meta && (event.meta.dueDate || event.meta.startDate)) || new Date().toISOString(),
        detail: event.body || "",
        source: event.kind || "event",
        status: "upcoming",
        meta: event.meta || {},
      });
    }
    dispatchReminderNotification(event);
  });
  contextMonitor.start();

  browserCompanionMonitor = new BrowserCompanionMonitor({
    createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
  });
  browserCompanionMonitor.on("offer", (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("her:event", event);
  });
  browserCompanionMonitor.start();

  browserHistoryEvolutionService = new BrowserHistoryEvolutionService({
    paths,
    stores,
    createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
    emit: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("her:event", event);
    },
  });
  browserHistoryEvolutionService.start();

  environmentMonitor = new EnvironmentMonitor();
  environmentMonitor.start();

  awarenessService = new AwarenessService({
    createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
    stores,
    environmentMonitor,
  });
  awarenessService.start();

  chatSession = new ChatSession({
    paths,
    stores,
    createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
    scheduleService,
    environmentMonitor,
    awarenessService,
  });

  chatSession.on("event", (event) => {
    if (event && event.type === "news_briefing_updated") {
      setupNewsBriefingCron(stores.settingsStore);
    }
  });

  const getPassiveContext = async () => {
    const [frontApp, calendar, currentPage] = await Promise.all([
      readFrontApp(),
      readCalendarEvents(),
      readCurrentBrowserContext().catch(() => null),
    ]);
    return { frontApp, calendar, currentPage };
  };

  const remoteDispatch = new RemoteDispatch({
    session: chatSession,
    stores,
    paths,
    environmentMonitor,
    getPassiveContext,
  });

  deviceAgent = new DeviceAgent({
    settingsStore: stores.settingsStore,
    dispatch: remoteDispatch,
  });
  deviceAgent.start();

  registerIpc({
    session: chatSession,
    getMainWindow: () => mainWindow,
    paths,
    stores,
    getDeviceAgent: () => deviceAgent,
  });

  // News briefing cron
  setupNewsBriefingCron(stores.settingsStore);
}

function setupNewsBriefingCron(settingsStore) {
  if (newsBriefingJob) { newsBriefingJob.stop(); newsBriefingJob = null; }

  const config = settingsStore.get().newsBriefing;
  if (!config || !config.enabled) return;

  const hour = config.hour || 9;
  const minute = config.minute || 0;
  const cron = `${minute} ${hour} * * 1-5`; // weekdays only

  newsBriefingJob = nodeCron.schedule(cron, () => {
    triggerNewsBriefing();
  });
  console.log(`[NewsBriefing] Scheduled at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} weekdays`);
}

function triggerNewsBriefing() {
  if (!chatSession) return;

  const prompt = `现在是早上，给我来一份今天的新闻早报。根据你对我的了解（我的职业、兴趣、最近关注的话题），搜我真正会感兴趣的新闻，图文并茂地展示，最后用几句话简短总结今天的重点。不要问我想看什么，你应该知道的。`;

  if (Notification.isSupported()) {
    const notification = new Notification({
      title: "Her · 早报",
      body: "正在为你整理今天的新闻...",
      silent: false,
    });
    notification.on("click", () => {
      ensureWindow();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
  }

  ensureWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.webContents.send("her:event", { type: "clear" });
  }

  setTimeout(() => {
    chatSession.sendMessage({ message: prompt, images: [] });
  }, 500);
}

function ensureWindow() {
  if (mainWindow) return;
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (process.platform === "darwin") {
  const dockIcon = nativeImage.createFromPath(path.join(__dirname, "../../build/icon.png"));
  if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
}

app.whenReady().then(async () => {
  try {
    await initializeApp();
    ensureWindow();

    // Global keyboard shortcut: Cmd+Shift+H to toggle window
    globalShortcut.register("CommandOrControl+Shift+H", () => {
      const isShowing = mainWindow && mainWindow.isVisible() && mainWindow.isFocused();
      if (isShowing) {
        mainWindow.hide();
      } else {
        if (!mainWindow) ensureWindow();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    // System tray icon with quick actions
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, "../../build/icon.png")).resize({ width: 18, height: 18 });
    tray = new Tray(trayIcon);
    tray.setToolTip("Her");
    const contextMenu = Menu.buildFromTemplate([
      { label: "打开 Her", click: () => { ensureWindow(); mainWindow.show(); mainWindow.focus(); } },
      { label: "新对话", click: () => { ensureWindow(); mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send("her:event", { type: "clear" }); } },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        ensureWindow();
      }
    });
  } catch (error) {
    console.error("[Her] Failed to bootstrap:", error);
    dialog.showErrorBox("Her", `Application failed to start:\n${error.message}`);
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    initializeApp().then(() => {
      ensureWindow();
    }).catch((error) => {
      console.error("[Her] Failed to reactivate:", error);
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Check if launched with a her:// URL
  const herUrl = argv.find((arg) => arg.startsWith("her://"));
  if (herUrl) handleHerUrl(herUrl);
});

// ── her:// URL Scheme handler ─────────────────────────────────────────
// Supported URLs:
//   her://ask?text=...       → send message to Her
//   her://remember?text=...  → ask Her to remember something
//   her://today              → ask Her what's on today
//   her://clear              → clear conversation
//   her://show               → just show the window

function handleHerUrl(url) {
  if (!url || !chatSession) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "her:") return;

    ensureWindow();
    mainWindow.show();
    mainWindow.focus();

    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
    const text = parsed.searchParams.get("text") || "";

    switch (action) {
      case "ask":
      case "chat":
        if (text) {
          setTimeout(() => chatSession.sendMessage({ message: text, images: [] }), 300);
        }
        break;
      case "remember":
        if (text) {
          setTimeout(() => chatSession.sendMessage({ message: `请记住这件事：${text}`, images: [] }), 300);
        }
        break;
      case "today":
        setTimeout(() => chatSession.sendMessage({ message: "今天有什么安排？帮我梳理一下", images: [] }), 300);
        break;
      case "clear":
        setTimeout(() => chatSession.sendMessage({ message: "/clear", images: [] }), 300);
        break;
      case "show":
        // just show the window, already done above
        break;
      default:
        // Treat unknown action as a chat message if text is provided
        if (text) {
          setTimeout(() => chatSession.sendMessage({ message: text, images: [] }), 300);
        }
        break;
    }
  } catch (err) {
    console.error("[Her] Failed to handle URL:", err.message);
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (!initialized) {
    // App not ready yet, queue it
    app.whenReady().then(() => setTimeout(() => handleHerUrl(url), 500));
  } else {
    handleHerUrl(url);
  }
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  ensureWindow();
  mainWindow.show();
  mainWindow.focus();
  // Send to renderer after a short delay to ensure window is ready
  setTimeout(() => {
    mainWindow.webContents.send("her:event", { type: "open-file", filePath });
  }, 500);
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  if (chatSession) chatSession.cancel();
  if (chatSession) chatSession.destroy();
  if (scheduleService) scheduleService.stop();
  if (contextMonitor) contextMonitor.stop();
  if (browserCompanionMonitor) browserCompanionMonitor.stop();
  if (browserHistoryEvolutionService) browserHistoryEvolutionService.stop();
  if (environmentMonitor) environmentMonitor.stop();
  if (awarenessService) awarenessService.stop();
  if (deviceAgent) deviceAgent.stop();
  if (newsBriefingJob) newsBriefingJob.stop();
});
