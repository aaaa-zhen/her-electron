/**
 * Her WeChat Bridge
 *
 * Bridges Her's ChatSession to WeChat via weixin-agent-sdk.
 * Each WeChat user gets their own conversation history and memory.
 *
 * Usage:
 *   node src/weixin/bridge.mjs
 *
 * Requires:
 *   npm install weixin-agent-sdk
 */

import { createRequire } from "module";
import { login, start } from "weixin-agent-sdk";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

// Her core modules (CommonJS)
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

// ============================================================================
// Configuration
// ============================================================================

// Use existing Her data dir, or fall back to ~/Library/Application Support/Her/data
const HER_DATA_DIR =
  process.env.HER_DATA_DIR ||
  path.join(
    os.homedir(),
    process.platform === "darwin"
      ? "Library/Application Support/Her/data"
      : ".her/data"
  );

const HER_SHARED_DIR =
  process.env.HER_SHARED_DIR ||
  path.join(path.dirname(HER_DATA_DIR), "shared");

const WEIXIN_DATA_DIR = path.join(HER_DATA_DIR, "weixin");

// Load .env if it exists
const envFile = path.join(path.dirname(HER_DATA_DIR), ".env");
if (fs.existsSync(envFile)) {
  require("dotenv").config({ path: envFile });
}

// ============================================================================
// Per-user session management
// ============================================================================

/** @type {Map<string, { session: ChatSession, lastActive: number }>} */
const sessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle → cleanup

function getUserDataDir(conversationId) {
  // Sanitize ID for filesystem
  const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(WEIXIN_DATA_DIR, safeId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getOrCreateSession(conversationId) {
  const existing = sessions.get(conversationId);
  if (existing) {
    existing.lastActive = Date.now();
    return existing.session;
  }

  const userDataDir = getUserDataDir(conversationId);

  const paths = { dataDir: userDataDir, sharedDir: HER_SHARED_DIR };
  [paths.dataDir, paths.sharedDir].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const stores = {
    settingsStore: new SettingsStore(HER_DATA_DIR), // shared settings (API keys)
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
    execAsync: (command, options) =>
      execAsync(command, { cwd: paths.sharedDir, ...options }),
    processScheduleOutput: null,
  });

  const session = new ChatSession({
    paths,
    stores,
    createAnthropicClient: () => createAnthropicClient(stores.settingsStore),
    scheduleService,
  });

  sessions.set(conversationId, { session, lastActive: Date.now() });
  console.log(`[WeChat] New session for ${conversationId}`);
  return session;
}

// Periodic cleanup of idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
      console.log(`[WeChat] Cleaned up idle session: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// Send message to Her and collect response
// ============================================================================

/**
 * Send a message to a ChatSession and wait for the complete response.
 * Returns { text, mediaPath }
 */
function chatWithHer(session, text, imagePaths = []) {
  return new Promise((resolve, reject) => {
    let responseText = "";
    let mediaFile = null;
    let errorText = null;

    const onEvent = (event) => {
      switch (event.type) {
        case "stream":
          responseText += event.text;
          break;
        case "file":
          // Capture the last file sent during this turn
          mediaFile = event;
          break;
        case "error":
          errorText = event.text;
          break;
      }
    };

    session.on("event", onEvent);

    const images = imagePaths.map((filePath) => {
      const data = fs.readFileSync(filePath);
      const base64 = data.toString("base64");
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      return { url: `data:${mimeMap[ext] || "image/jpeg"};base64,${base64}` };
    });

    session
      .sendMessage({ message: text, images: images.length > 0 ? images : undefined })
      .then(() => {
        session.removeListener("event", onEvent);

        if (errorText && !responseText) {
          resolve({ text: `[Error] ${errorText}` });
          return;
        }

        // Clean up [SILENT] responses
        const cleanText = responseText.trim();
        if (cleanText === "[SILENT]" || cleanText === "") {
          resolve({ text: undefined });
          return;
        }

        const result = { text: cleanText };

        // Attach media if Her sent a file
        if (mediaFile) {
          // Resolve file path from URL or shared dir
          let filePath = "";
          if (mediaFile.url && mediaFile.url.startsWith("file://")) {
            filePath = decodeURIComponent(
              mediaFile.url.replace("file://", "")
            );
          } else if (mediaFile.filename) {
            filePath = path.join(HER_SHARED_DIR, mediaFile.filename);
          }

          if (filePath && fs.existsSync(filePath)) {
            const ext = path.extname(filePath).toLowerCase();
            const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
            const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

            let mediaType = "file";
            if (imageExts.includes(ext)) mediaType = "image";
            else if (videoExts.includes(ext)) mediaType = "video";

            result.media = {
              type: mediaType,
              url: filePath,
              fileName: mediaFile.filename,
            };
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

// ============================================================================
// WeChat Agent implementation
// ============================================================================

/** @type {import("weixin-agent-sdk").Agent} */
const herAgent = {
  async chat(request) {
    const { conversationId, text, media } = request;

    const session = getOrCreateSession(conversationId);

    // Build message text
    let messageText = text || "";

    // Handle media attachments
    const imagePaths = [];

    if (media) {
      switch (media.type) {
        case "image":
          imagePaths.push(media.filePath);
          if (!messageText) messageText = "[image]";
          break;
        case "audio":
          // Audio is already transcribed to text by WeChat SDK
          // But if text is empty, mention it
          if (!messageText) messageText = "[voice message]";
          break;
        case "video":
          messageText += messageText
            ? `\n[Video file: ${media.filePath}]`
            : `[Video file: ${media.filePath}]`;
          break;
        case "file":
          messageText += messageText
            ? `\n[File: ${media.fileName || media.filePath}]`
            : `[File: ${media.fileName || media.filePath}]`;
          break;
      }
    }

    if (!messageText.trim()) {
      return { text: undefined };
    }

    try {
      console.log(`[WeChat] ${conversationId}: ${messageText.slice(0, 100)}`);
      const response = await chatWithHer(session, messageText, imagePaths);
      console.log(
        `[WeChat] Reply: ${(response.text || "").slice(0, 100)}${response.media ? " +media" : ""}`
      );
      return response;
    } catch (err) {
      console.error(`[WeChat] Error for ${conversationId}:`, err.message);
      return { text: `Something went wrong: ${err.message}` };
    }
  },
};

// ============================================================================
// Main
// ============================================================================

console.log("[Her WeChat Bridge]");
console.log(`  Data dir:   ${HER_DATA_DIR}`);
console.log(`  Shared dir: ${HER_SHARED_DIR}`);
console.log(`  WeChat dir: ${WEIXIN_DATA_DIR}`);
console.log();

await login();
await start(herAgent);
