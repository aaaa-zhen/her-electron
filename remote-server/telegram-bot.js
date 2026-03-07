const https = require("https");
const WebSocket = require("ws");

const TG_TOKEN = process.env.HER_TG_BOT_TOKEN || "";
const CLIENT_TOKEN = process.env.HER_RELAY_CLIENT_TOKEN || process.env.HER_RELAY_ACCESS_TOKEN || "dev-client-token";
const RELAY_WS_URL = process.env.HER_RELAY_WS_URL || "ws://127.0.0.1:3939/ws/client";
const ALLOWED_CHAT_IDS = (process.env.HER_TG_ALLOWED_CHATS || "").split(",").map((s) => s.trim()).filter(Boolean);

// How often to flush buffered stream text to Telegram (ms)
const STREAM_FLUSH_INTERVAL = 800;

if (!TG_TOKEN) {
  console.error("[tg-bot] HER_TG_BOT_TOKEN is required");
  process.exit(1);
}

// --- Telegram API helpers ---

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TG_TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendTgMessage(chatId, text) {
  const result = await tgApi("sendMessage", {
    chat_id: chatId,
    text: text || "(empty)",
    parse_mode: "Markdown",
  }).catch(() => null);
  // Fallback without markdown if parsing fails
  if (result && !result.ok) {
    return tgApi("sendMessage", { chat_id: chatId, text: text || "(empty)" });
  }
  return result;
}

async function editTgMessage(chatId, messageId, text) {
  const result = await tgApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text || "(empty)",
    parse_mode: "Markdown",
  }).catch(() => null);
  if (result && !result.ok) {
    return tgApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text || "(empty)",
    }).catch(() => null);
  }
  return result;
}

function sendChatAction(chatId, action) {
  return tgApi("sendChatAction", { chat_id: chatId, action: action || "typing" }).catch(() => {});
}

// --- Relay WebSocket connection ---

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
const pending = new Map();

function connectRelay() {
  if (ws) return;
  const url = `${RELAY_WS_URL}?token=${encodeURIComponent(CLIENT_TOKEN)}`;
  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log("[tg-bot] Connected to relay");
    reconnectDelay = 2000;
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (!msg || typeof msg !== "object") return;

    // --- Streaming chunk ---
    if (msg.type === "chat.stream") {
      const entry = pending.get(msg.requestId);
      if (!entry || typeof msg.text !== "string") return;
      entry.streamBuf += msg.text;
      // Flush is handled by the interval timer in the entry
      return;
    }

    // --- Final response ---
    if (msg.type === "chat.response") {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      finishEntry(msg.requestId, entry, (msg.payload && msg.payload.reply) || "");
      return;
    }

    if (msg.type === "job.result") {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      finishEntry(msg.requestId, entry, formatJobResult(msg.payload || {}));
      return;
    }

    if (msg.type === "job.error") {
      const entry = pending.get(msg.requestId);
      if (!entry) return;
      finishEntry(msg.requestId, entry, `Error: ${msg.error || "request failed"}`);
      return;
    }
  });

  ws.on("close", () => {
    console.log("[tg-bot] Relay disconnected");
    ws = null;
    scheduleReconnect();
  });

  ws.on("error", () => {
    try { ws.close(); } catch (_) {}
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, reconnectDelay);
  reconnectDelay = Math.min(30000, reconnectDelay * 2);
}

function relaySend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
}

function createRequestId() {
  return `tg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// --- Streaming flush logic ---

function createPendingEntry(chatId) {
  const entry = {
    chatId,
    createdAt: Date.now(),
    typingInterval: setInterval(() => sendChatAction(chatId, "typing"), 4000),
    // Stream state
    streamBuf: "",         // text received but not yet flushed
    streamFlushed: "",     // text already displayed in Telegram
    tgMessageId: null,     // Telegram message ID (set after first send)
    tgSending: false,      // guard to avoid concurrent edits
    flushTimer: null,
  };

  // Periodically flush buffered stream text
  entry.flushTimer = setInterval(() => flushStream(entry), STREAM_FLUSH_INTERVAL);
  sendChatAction(chatId, "typing");
  return entry;
}

async function flushStream(entry) {
  if (entry.tgSending) return;
  const fullText = entry.streamFlushed + entry.streamBuf;
  if (!entry.streamBuf || fullText === entry.streamFlushed) return;

  // Consume the buffer
  entry.streamFlushed = fullText;
  entry.streamBuf = "";
  entry.tgSending = true;

  try {
    if (!entry.tgMessageId) {
      // First chunk — send new message
      const result = await sendTgMessage(entry.chatId, fullText + " ...");
      if (result && result.ok && result.result) {
        entry.tgMessageId = result.result.message_id;
      }
    } else {
      // Subsequent — edit existing message
      await editTgMessage(entry.chatId, entry.tgMessageId, fullText + " ...");
    }
  } catch (_) {}
  entry.tgSending = false;
}

async function finishEntry(requestId, entry, finalText) {
  clearInterval(entry.typingInterval);
  clearInterval(entry.flushTimer);
  pending.delete(requestId);

  // If we already have a streaming message, edit it with the final text
  // Otherwise send a new message
  // Wait for any in-flight send to finish
  const waitSend = () => new Promise((r) => {
    if (!entry.tgSending) return r();
    const check = setInterval(() => { if (!entry.tgSending) { clearInterval(check); r(); } }, 100);
  });
  await waitSend();

  if (entry.tgMessageId && finalText) {
    await editTgMessage(entry.chatId, entry.tgMessageId, finalText);
  } else if (finalText) {
    await sendTgMessage(entry.chatId, finalText);
  }
}

// --- Format job results as text ---

function formatJobResult(payload) {
  if (!payload || typeof payload !== "object") return "No result.";

  if (payload.action === "timeline.today") {
    const lines = [];
    const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    const todos = Array.isArray(payload.todos) ? payload.todos : [];
    if (timeline.length > 0) {
      lines.push("*Today Timeline*");
      timeline.forEach((item) => {
        const time = item.at ? item.at.slice(11, 16) : "";
        lines.push(`- ${item.title}${time ? ` (${time})` : ""}`);
      });
    }
    if (todos.length > 0) {
      lines.push("\n*Today Todos*");
      todos.forEach((item) => lines.push(`- ${item.title}${item.dueDate ? ` (${item.dueDate})` : ""}`));
    }
    return lines.join("\n") || "Nothing captured today yet.";
  }

  if (payload.action === "context.current") {
    const ctx = payload.context || {};
    const lines = ["*Current Context*"];
    lines.push(`Front App: ${ctx.frontApp || "unknown"}`);
    if (ctx.currentPage) lines.push(`Page: ${ctx.currentPage.title || ctx.currentPage.url || "detected"}`);
    if (Array.isArray(ctx.calendar) && ctx.calendar.length > 0) {
      lines.push(`Calendar: ${ctx.calendar.map((e) => e.title).join(", ")}`);
    }
    if (Array.isArray(ctx.activeTodos) && ctx.activeTodos.length > 0) {
      lines.push(`Todos: ${ctx.activeTodos.map((t) => t.title).join(", ")}`);
    }
    return lines.join("\n");
  }

  if (payload.action === "artifact.recall") {
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    if (artifacts.length === 0) return "No recent files found.";
    const lines = ["*Recent Files*"];
    artifacts.forEach((a) => lines.push(`- ${a.filename}${a.sizeLabel ? ` (${a.sizeLabel})` : ""}`));
    return lines.join("\n");
  }

  return JSON.stringify(payload, null, 2).slice(0, 3000);
}

// --- Telegram polling ---

let offset = 0;

async function poll() {
  try {
    const result = await tgApi("getUpdates", { offset, timeout: 30 });
    if (!result || !result.ok || !Array.isArray(result.result)) return;

    for (const update of result.result) {
      offset = update.update_id + 1;
      if (!update.message || !update.message.text) continue;

      const chatId = String(update.message.chat.id);
      const text = update.message.text.trim();
      const from = update.message.from;

      if (ALLOWED_CHAT_IDS.length > 0 && !ALLOWED_CHAT_IDS.includes(chatId)) {
        console.log(`[tg-bot] Blocked message from chat ${chatId}`);
        await sendTgMessage(chatId, "Not authorized.");
        continue;
      }

      console.log(`[tg-bot] ${from ? from.first_name : "?"} (${chatId}): ${text.slice(0, 60)}`);

      if (text === "/start") {
        await sendTgMessage(chatId, "Hey, I'm Her. Send me anything and I'll respond from your Mac.");
        continue;
      }
      if (text === "/status") {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          await sendTgMessage(chatId, "Relay disconnected. Reconnecting...");
          connectRelay();
        } else {
          await sendTgMessage(chatId, "Connected to relay.");
        }
        continue;
      }
      if (text === "/today") { await handleJob(chatId, "timeline.today", {}); continue; }
      if (text === "/context") { await handleJob(chatId, "context.current", {}); continue; }
      if (text === "/files") { await handleJob(chatId, "artifact.recall", { limit: 6 }); continue; }

      await handleChat(chatId, text);
    }
  } catch (err) {
    console.error("[tg-bot] Poll error:", err.message);
  }
  setTimeout(poll, 500);
}

async function handleChat(chatId, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    await sendTgMessage(chatId, "Mac is offline right now.");
    return;
  }
  const requestId = createRequestId();
  const entry = createPendingEntry(chatId);
  pending.set(requestId, entry);
  relaySend({ type: "chat.request", requestId, payload: { message: text } });
}

async function handleJob(chatId, action, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    await sendTgMessage(chatId, "Mac is offline right now.");
    return;
  }
  const requestId = createRequestId();
  const entry = createPendingEntry(chatId);
  pending.set(requestId, entry);
  relaySend({ type: "job.request", requestId, action, payload: payload || {} });
}

// Cleanup stale pending requests (5 min timeout)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending.entries()) {
    if (now - entry.createdAt > 5 * 60 * 1000) {
      finishEntry(id, entry, "Request timed out.");
    }
  }
}, 30000);

// --- Start ---
console.log("[tg-bot] Starting (streaming enabled)...");
connectRelay();
setTimeout(poll, 1000);
