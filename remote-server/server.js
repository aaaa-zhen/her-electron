const crypto = require("crypto");
const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.HER_RELAY_PORT || 3939);
const ADMIN_SECRET = process.env.HER_RELAY_ADMIN_SECRET || "";
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days without any connection → cleanup
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly cleanup

const app = express();
const server = http.createServer(app);
const agentWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

// ── Multi-user Room storage ──────────────────────────────────────────

// tokenMap: agentToken → { pairId, clientToken, createdAt }
//           clientToken → { pairId, agentToken, createdAt }
const tokenMap = new Map();

// rooms: pairId → Room
const rooms = new Map();

function createRoom(pairId) {
  return {
    pairId,
    agentSocket: null,
    clients: new Set(),
    pendingRequests: new Map(),
    agentStatus: {
      connected: false,
      deviceName: "",
      capabilities: [],
      updatedAt: null,
    },
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function now() {
  return new Date().toISOString();
}

function parseToken(requestUrl, req) {
  const parsed = new URL(requestUrl, "http://localhost");
  const queryToken = parsed.searchParams.get("token") || "";
  const authHeader = String(req.headers.authorization || "");
  if (queryToken) return queryToken;
  if (authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  return "";
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function buildAgentStatusPayload(room) {
  return {
    connected: Boolean(room.agentSocket && room.agentSocket.readyState === WebSocket.OPEN),
    ...room.agentStatus,
    connectedAt: room.agentStatus.connectedAt || null,
    updatedAt: now(),
  };
}

function broadcastStatus(room) {
  const payload = {
    type: "agent.status",
    payload: buildAgentStatusPayload(room),
  };
  for (const client of room.clients) {
    sendJson(client, payload);
  }
}

function failPendingRequests(room, message) {
  for (const [requestId, pending] of room.pendingRequests.entries()) {
    sendJson(pending.ws, {
      type: "job.error",
      requestId,
      error: message,
    });
    room.pendingRequests.delete(requestId);
  }
}

// ── Room cleanup ─────────────────────────────────────────────────────

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [pairId, room] of rooms.entries()) {
    const hasAgent = room.agentSocket && room.agentSocket.readyState === WebSocket.OPEN;
    const hasClients = room.clients.size > 0;
    if (!hasAgent && !hasClients && room.lastActivity < cutoff) {
      // Remove token mappings
      for (const [token, info] of tokenMap.entries()) {
        if (info.pairId === pairId) tokenMap.delete(token);
      }
      rooms.delete(pairId);
      console.log(`[relay] cleaned up expired room ${pairId.slice(0, 8)}…`);
    }
  }
}

setInterval(cleanupRooms, CLEANUP_INTERVAL_MS);

// ── HTTP API ─────────────────────────────────────────────────────────

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  const roomStats = [];
  for (const [pairId, room] of rooms.entries()) {
    roomStats.push({
      pairId: pairId.slice(0, 8) + "…",
      agentConnected: Boolean(room.agentSocket && room.agentSocket.readyState === WebSocket.OPEN),
      clients: room.clients.size,
      pendingRequests: room.pendingRequests.size,
      deviceName: room.agentStatus.deviceName || "",
    });
  }
  res.json({
    ok: true,
    rooms: roomStats.length,
    pairs: tokenMap.size / 2,
    details: roomStats,
  });
});

// Register a token pair — called by Electron client when generating QR code
app.post("/api/pair", (req, res) => {
  const { agentToken, clientToken } = req.body || {};
  if (!agentToken || !clientToken || agentToken.length < 16 || clientToken.length < 16) {
    return res.status(400).json({ error: "agentToken and clientToken required (min 16 chars)" });
  }
  if (agentToken === clientToken) {
    return res.status(400).json({ error: "agentToken and clientToken must be different" });
  }

  // Check if tokens already exist
  if (tokenMap.has(agentToken) || tokenMap.has(clientToken)) {
    const existing = tokenMap.get(agentToken) || tokenMap.get(clientToken);
    return res.json({ pairId: existing.pairId, existing: true });
  }

  const pairId = crypto.randomUUID();
  const createdAt = Date.now();

  tokenMap.set(agentToken, { pairId, role: "agent", createdAt });
  tokenMap.set(clientToken, { pairId, role: "client", createdAt });

  // Pre-create the room
  rooms.set(pairId, createRoom(pairId));

  console.log(`[relay] new pair registered: ${pairId.slice(0, 8)}…`);
  res.json({ pairId, existing: false });
});

// Unpair — called by Electron client to revoke tokens
app.delete("/api/pair", (req, res) => {
  const { agentToken } = req.body || {};
  if (!agentToken) {
    return res.status(400).json({ error: "agentToken required" });
  }

  const info = tokenMap.get(agentToken);
  if (!info) {
    return res.status(404).json({ error: "Token not found" });
  }

  const { pairId } = info;
  const room = rooms.get(pairId);

  // Close all connections in this room
  if (room) {
    if (room.agentSocket && room.agentSocket.readyState === WebSocket.OPEN) {
      try { room.agentSocket.close(4001, "Pair revoked"); } catch (_) {}
    }
    for (const client of room.clients) {
      try { client.close(4001, "Pair revoked"); } catch (_) {}
    }
    failPendingRequests(room, "Connection revoked.");
    rooms.delete(pairId);
  }

  // Remove all token mappings for this pairId
  for (const [token, tokenInfo] of tokenMap.entries()) {
    if (tokenInfo.pairId === pairId) tokenMap.delete(token);
  }

  console.log(`[relay] pair revoked: ${pairId.slice(0, 8)}…`);
  res.json({ ok: true });
});

// ── Shortcut install page for iPhone ─────────────────────────────────

app.get("/shortcuts", (req, res) => {
  const token = req.query.token || "";
  const wsProto = req.protocol === "https" ? "wss:" : "ws:";
  const host = req.get("host");
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Her">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%236ee7b7'/><text x='50' y='62' text-anchor='middle' font-size='40' font-weight='bold' font-family='sans-serif' fill='%230a0a0a'>H</text></svg>">
<link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%230c0c0c'/><circle cx='50' cy='50' r='30' fill='%236ee7b7'/><text x='50' y='62' text-anchor='middle' font-size='34' font-weight='bold' font-family='sans-serif' fill='%230a0a0a'>H</text></svg>">
<title>Her</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0a0a0a;--surface:#151515;--surface2:#1c1c1c;
  --border:rgba(255,255,255,.06);
  --text:#e8e8e8;--text2:#888;--text3:#555;
  --accent:#6ee7b7;--accent-dim:rgba(110,231,183,.1);
  --her-border:rgba(110,231,183,.1);
  --user-bg:rgba(255,255,255,.05);
  --radius:16px;
}
html,body{height:100%;background:var(--bg)}
body{font-family:-apple-system,'SF Pro Text','Inter',sans-serif;color:var(--text);display:flex;flex-direction:column;overflow:hidden}

header{
  padding:14px 20px;background:var(--bg);
  display:flex;align-items:center;justify-content:center;
  position:relative;flex-shrink:0;
  border-bottom:1px solid var(--border);
  padding-top:max(14px,env(safe-area-inset-top));
}
.hd-name{font-size:15px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px}
.hd-dot{width:7px;height:7px;border-radius:50%;background:var(--text3);transition:all .3s}
.hd-dot.online{background:var(--accent)}
.hd-dot.offline{background:#f87171}
.hd-status{font-size:11px;font-weight:500;color:var(--text3);transition:all .3s}
.hd-status.connected{color:var(--accent)}
.hd-actions{position:absolute;right:16px;display:flex;gap:6px}
.hd-btn{
  width:32px;height:32px;border-radius:10px;background:transparent;
  border:1px solid var(--border);color:var(--text3);cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:all .2s;
}
.hd-btn:active{background:var(--surface);color:var(--text2)}
.hd-btn svg{width:15px;height:15px}

#messages{
  flex:1;overflow-y:auto;overflow-x:hidden;
  padding:16px 16px 24px;
  scroll-behavior:smooth;
  overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;
}
.msg-list{max-width:680px;margin:0 auto;display:flex;flex-direction:column;gap:4px}

.welcome{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:60vh;text-align:center;padding:40px 20px;
}
.welcome-icon{
  width:64px;height:64px;border-radius:50%;background:var(--accent);
  display:flex;align-items:center;justify-content:center;margin-bottom:24px;
}
.welcome-icon span{font-size:28px;font-weight:700;color:#0a0a0a}
.welcome h2{font-size:22px;font-weight:700;color:#fff;margin-bottom:8px}
.welcome p{font-size:14px;color:var(--text2);line-height:1.6;max-width:300px}
.welcome-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:24px}
.chip{
  padding:8px 16px;border-radius:20px;
  background:var(--surface);border:1px solid var(--border);
  font-size:13px;font-weight:500;color:var(--text2);cursor:pointer;transition:all .2s;
}
.chip:active{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}

.msg{padding:2px 0;animation:msgIn .25s ease-out;max-width:680px;margin:0 auto;width:100%}
@keyframes msgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

.msg-user{display:flex;justify-content:flex-end;padding:2px 0}
.msg-user .bubble{
  background:var(--user-bg);border:1px solid var(--border);
  border-radius:var(--radius) var(--radius) 4px var(--radius);
  padding:10px 16px;max-width:85%;
  font-size:15px;line-height:1.6;color:var(--text);word-break:break-word;
}
.msg-her{padding:6px 0}
.msg-her .bubble{padding:2px 4px;max-width:100%;font-size:15px;line-height:1.75;color:var(--text);word-break:break-word}
.msg-her .her-label{font-size:12px;font-weight:600;color:var(--accent);margin-bottom:4px;display:flex;align-items:center;gap:5px}

.md h1{font-size:20px;font-weight:700;color:#fff;margin:12px 0 6px}
.md h2{font-size:17px;font-weight:700;color:#fff;margin:10px 0 5px}
.md h3{font-size:15px;font-weight:700;color:#fff;margin:8px 0 4px}
.md h1:first-child,.md h2:first-child,.md h3:first-child{margin-top:0}
.md p{margin:4px 0}
.md strong{font-weight:600;color:#fff}
.md em{color:var(--text2)}
.md code{background:rgba(110,231,183,.08);padding:2px 6px;border-radius:4px;font-family:'SF Mono',monospace;font-size:13px;color:var(--accent)}
.md pre{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin:8px 0;overflow:hidden;font-family:'SF Mono',monospace;font-size:13px;line-height:1.55;color:var(--text2)}
.pre-header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.03)}
.pre-lang{font-size:11px;color:var(--text2);opacity:.6}
.md pre code{background:none;padding:12px 16px;color:inherit;font-size:inherit;display:block;overflow-x:auto}
.copy-btn{background:rgba(255,255,255,.08);border:1px solid var(--border);color:var(--text2);font-size:11px;padding:3px 9px;border-radius:6px;cursor:pointer;transition:background .2s}
.copy-btn.copied{color:var(--accent);border-color:var(--accent)}
.md ul,.md ol{margin:4px 0;padding-left:20px}
.md li{margin:2px 0}
.md li::marker{color:var(--accent)}
.md blockquote{border-left:3px solid var(--accent);padding:3px 12px;margin:6px 0;color:var(--text2);border-radius:0 6px 6px 0}
.md hr{border:none;border-top:1px solid var(--border);margin:12px 0}
.md a{color:var(--accent);text-decoration:none}
.md table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.md thead{background:rgba(255,255,255,.03)}
.md th{padding:7px 11px;text-align:left;font-weight:600;color:#fff;border-bottom:1px solid var(--border)}
.md td{padding:6px 11px;border-bottom:1px solid var(--border)}
.md tbody tr:last-child td{border-bottom:none}

.typing-cursor::after{content:'';display:inline-block;width:2px;height:16px;background:var(--accent);margin-left:2px;vertical-align:text-bottom;animation:blink .6s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

.thinking{display:flex;align-items:center;gap:4px;padding:8px 4px}
.thinking span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1.4s infinite both;opacity:.3}
.thinking span:nth-child(2){animation-delay:.2s}
.thinking span:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{opacity:.15}40%{opacity:.7}}

.cmd-block{margin:6px 0;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.cmd-bar{padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:background .1s}
.cmd-bar:active{background:rgba(255,255,255,.02)}
.cmd-spinner{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.cmd-icon{width:14px;height:14px;flex-shrink:0}
.cmd-icon.done{color:var(--accent)}
.cmd-label{font-size:12px;font-weight:500;color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-toggle{font-size:10px;color:var(--text3);flex-shrink:0;transition:transform .15s}
.cmd-toggle.open{transform:rotate(180deg)}
.cmd-detail{display:none;border-top:1px solid var(--border);font-family:'SF Mono',monospace;font-size:12px}
.cmd-detail.open{display:block}
.cmd-detail-cmd{padding:8px 12px;color:var(--accent);white-space:pre-wrap;word-break:break-all;line-height:1.5}
.cmd-detail-out{padding:8px 12px;color:var(--text2);border-top:1px solid var(--border);white-space:pre-wrap;word-break:break-all;line-height:1.5;max-height:200px;overflow-y:auto}

.bubble.streaming{animation:pulse-border 2s ease-in-out infinite;border:1px solid var(--border)}
@keyframes pulse-border{0%,100%{border-color:var(--border)}50%{border-color:rgba(110,231,183,.5)}}

.msg-timestamp{text-align:center;font-size:11px;color:var(--text3);margin:12px 0 4px;user-select:none;letter-spacing:0.5px}

#input-area{padding:8px 16px;padding-bottom:max(16px,env(safe-area-inset-bottom));background:var(--bg);flex-shrink:0}
.input-box{
  max-width:680px;margin:0 auto;
  background:var(--surface);border:1px solid var(--border);
  border-radius:22px;transition:border-color .3s,box-shadow .3s;
}
.input-box:focus-within{border-color:rgba(110,231,183,.3);box-shadow:0 0 10px rgba(110,231,183,.12),0 0 24px rgba(110,231,183,.06)}
.input-row{display:flex;align-items:center;padding:4px 6px 4px 14px;gap:2px}
#input{
  flex:1;background:transparent;border:none;padding:10px 8px;color:var(--text);
  font-size:15px;font-family:inherit;resize:none;outline:none;
  min-height:42px;max-height:120px;line-height:1.55;
}
#input::placeholder{color:var(--text3);font-size:13px}
#send{
  width:36px;height:36px;border-radius:50%;border:none;
  background:var(--text3);color:var(--bg);cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;transition:all .2s;
}
#send.active{background:var(--accent)}
#send:active{transform:scale(.9)}
#send:disabled{opacity:.3;cursor:not-allowed;transform:none}
#send svg{width:15px;height:15px}
#send.stop{background:var(--accent);opacity:1;cursor:pointer}
#send.stop svg{width:12px;height:12px}
.input-hint{max-width:680px;margin:6px auto 0;font-size:11px;color:var(--text3);text-align:center}

.toast{
  position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-80px);
  background:var(--surface2);color:var(--text);padding:8px 16px;border-radius:12px;
  font-size:13px;font-weight:500;border:1px solid var(--border);z-index:300;
  transition:transform .3s cubic-bezier(.32,0,.15,1);box-shadow:0 8px 32px rgba(0,0,0,.5);
}
.toast.show{transform:translateX(-50%) translateY(0)}

.new-msg-btn{
  position:sticky;bottom:8px;left:50%;transform:translateX(-50%);
  background:var(--accent);color:#0a0a0a;border:none;border-radius:20px;
  padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer;z-index:10;
  box-shadow:0 2px 12px rgba(0,0,0,.3);display:none;font-family:inherit;
}

.add-home{
  background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:14px 16px;margin:0 16px 8px;text-align:center;display:none;flex-shrink:0;
}
.add-home p{font-size:12px;color:var(--text3);line-height:1.6}
.add-home strong{color:var(--text)}
.add-home .dismiss{background:none;border:none;color:var(--text3);font-size:11px;margin-top:8px;cursor:pointer}

::-webkit-scrollbar{width:0;height:0}
</style>
</head>
<body>

<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="i-bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>
  </symbol>
  <symbol id="i-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>
  </symbol>
  <symbol id="i-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2"/>
  </symbol>
  <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 5v14"/><path d="M5 12h14"/>
  </symbol>
  <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
  </symbol>
</svg>

<header>
  <div class="hd-name">Her <span class="hd-dot" id="statusDot"></span><span class="hd-status" id="statusText">连接中...</span></div>
  <div class="hd-actions">
    <button class="hd-btn" id="newChatBtn" title="新对话">
      <svg><use href="#i-plus"/></svg>
    </button>
  </div>
</header>

<div id="messages">
  <div class="msg-list" id="msgList">
    <div class="welcome" id="welcome">
      <div class="welcome-icon"><span>H</span></div>
      <h2>Hey, I'm Her</h2>
      <p>你的 AI 伙伴 — 随时随地，什么都能帮。</p>
      <div class="welcome-chips">
        <div class="chip" data-msg="你好呀">聊聊天</div>
        <div class="chip" data-msg="今天有什么安排？">今日安排</div>
        <div class="chip" data-msg="帮我总结一下今天做了什么">今日小结</div>
        <div class="chip" data-msg="记住我的名字">记住我</div>
      </div>
    </div>
  </div>
  <button class="new-msg-btn" id="newMsgBtn" style="display:none">↓ 有新消息</button>
</div>

<div class="add-home" id="addHomeHint">
  <p>点击 Safari <strong>分享按钮</strong> → <strong>添加到主屏幕</strong><br>像 App 一样使用 Her</p>
  <button class="dismiss" onclick="this.parentElement.style.display='none'">知道了</button>
</div>

<div id="input-area">
  <div class="input-box" id="input-box">
    <div class="input-row">
      <textarea id="input" rows="1" placeholder="说点什么..."></textarea>
      <button id="send" disabled><svg><use href="#i-send"/></svg></button>
    </div>
  </div>
  <div class="input-hint" id="inputHint"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const TOKEN="${token}";
const WS_URL="${wsProto}//${host}/ws/client?token=${token}";
const msgList=document.getElementById("msgList");
const messagesEl=document.getElementById("messages");
const welcomeEl=document.getElementById("welcome");
const input=document.getElementById("input");
const sendBtn=document.getElementById("send");
const statusDot=document.getElementById("statusDot");
const statusText=document.getElementById("statusText");

let ws,reconnectDelay=1000,reconnectAttempts=0;
let isGenerating=false;
let userNearBottom=true,newMessagesBelow=false;
let streamBuf="",streamEl=null,streamTimer=null,streamGroup=null,thinkingEl=null,currentCmd=null;
let lastMsgTs=0;
let pendingRequestId=null;

messagesEl.addEventListener("scroll",()=>{
  const dist=messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight;
  userNearBottom=dist<300;
  if(userNearBottom)newMessagesBelow=false;
  updateNewMsgBtn();
});
function updateNewMsgBtn(){document.getElementById("newMsgBtn").style.display=newMessagesBelow?"":"none"}
document.getElementById("newMsgBtn").onclick=()=>{messagesEl.scrollTop=messagesEl.scrollHeight;newMessagesBelow=false;updateNewMsgBtn()};
function scrollDown(){
  if(userNearBottom){messagesEl.scrollTop=messagesEl.scrollHeight;newMessagesBelow=false}
  else newMessagesBelow=true;
  updateNewMsgBtn();
}
function esc(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML}
function toast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}

function setGenerating(val){
  isGenerating=val;
  if(val){sendBtn.disabled=false;sendBtn.classList.add("stop");sendBtn.classList.remove("active");sendBtn.innerHTML='<svg><use href="#i-stop"/></svg>'}
  else{sendBtn.classList.remove("stop");sendBtn.innerHTML='<svg><use href="#i-send"/></svg>';updateSendBtn()}
}
function finishCmd(){
  if(!currentCmd)return;
  const sp=currentCmd.querySelector(".cmd-spinner");
  if(sp)sp.outerHTML='<svg class="cmd-icon done"><use href="#i-check"/></svg>';
  const lb=currentCmd.querySelector(".cmd-label");
  if(lb&&lb.textContent.startsWith("Running:"))lb.textContent=lb.textContent.replace("Running:","Done:");
  currentCmd=null;
}
function removeThinking(){if(thinkingEl){thinkingEl.remove();thinkingEl=null}}

function flushStream(){if(!streamEl||!streamBuf)return;streamEl.innerHTML=md(streamBuf);streamEl.classList.add("typing-cursor");scrollDown()}
function appendStream(text){streamBuf+=text;if(!streamTimer)streamTimer=setTimeout(()=>{streamTimer=null;flushStream()},50)}
function endStream(){
  if(streamTimer){clearTimeout(streamTimer);streamTimer=null}
  if(streamEl&&streamBuf){streamEl.innerHTML=md(streamBuf);streamEl.classList.remove("typing-cursor")}
  if(streamGroup)streamGroup.classList.remove("streaming");
  streamEl=null;streamBuf="";currentCmd=null;setGenerating(false);scrollDown();
}

function md(raw){
  if(raw.length>40000)return'<pre style="white-space:pre-wrap;word-break:break-all;font-size:13px;color:var(--text2)">'+esc(raw)+'</pre>';
  const blocks=[];
  let h=raw.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,(_,l,c)=>{
    const code=esc(c.replace(/^\\n|\\n$/g,''));const lang=l||'code';
    blocks.push('<pre><div class="pre-header"><span class="pre-lang">'+lang+'</span><button class="copy-btn" onclick="copyCode(this)">复制</button></div><code>'+code+'</code></pre>');
    return "\\x00B"+(blocks.length-1)+"\\x00";
  });
  h=esc(h);
  h=h.replace(/\\x00B(\\d+)\\x00/g,(_,i)=>blocks[+i]);
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h=h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h=h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  h=h.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  h=h.replace(/^---$/gm,'<hr>');
  h=h.replace(/((?:^\\d+\\. .+$\\n?)+)/gm,block=>'<ol>'+block.trim().split('\\n').map(l=>'<li>'+l.replace(/^\\d+\\.\\s+/,'')+'</li>').join('')+'</ol>');
  h=h.replace(/((?:^[\\-\\*] .+$\\n?)+)/gm,block=>'<ul>'+block.trim().split('\\n').map(l=>'<li>'+l.replace(/^[\\-\\*]\\s+/,'')+'</li>').join('')+'</ul>');
  h=h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,(_,label,url)=>/^https?:\\/\\//i.test(url)?'<a href="'+url+'" target="_blank" rel="noopener">'+label+'</a>':label+' ('+url+')');
  h=h.replace(/^(?!<[hupbloait]|\\/|<hr)(.*\\S.*)$/gm,'<p>$1</p>');
  h=h.replace(/\\n{2,}/g,'\\n');
  return h;
}
function copyCode(btn){
  const code=btn.closest('pre').querySelector('code').innerText;
  if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(code);
  else{const ta=document.createElement('textarea');ta.value=code;ta.style.cssText='position:fixed;left:-9999px';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta)}
  btn.textContent="已复制 ✓";btn.classList.add("copied");setTimeout(()=>{btn.textContent="复制";btn.classList.remove("copied")},1500);
}

function fmtTime(){const d=new Date(),h=d.getHours(),m=d.getMinutes();return(h<10?"0":"")+h+":"+(m<10?"0":"")+m}
function maybeAddTs(){if(Date.now()-lastMsgTs<300000)return;lastMsgTs=Date.now();const ts=document.createElement("div");ts.className="msg-timestamp";ts.textContent=fmtTime();msgList.appendChild(ts)}

function getHerGroup(){
  if(streamGroup)return streamGroup;
  if(welcomeEl)welcomeEl.style.display="none";
  maybeAddTs();
  const msg=document.createElement("div");msg.className="msg msg-her";
  const bubble=document.createElement("div");bubble.className="bubble streaming";
  const label=document.createElement("div");label.className="her-label";
  label.innerHTML='<svg style="width:12px;height:12px"><use href="#i-bot"/></svg> Her';
  bubble.appendChild(label);msg.appendChild(bubble);msgList.appendChild(msg);
  streamGroup=bubble;return bubble;
}
function finalizeHerGroup(){streamGroup=null}

// ── WebSocket ──
function connect(){
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{
    reconnectDelay=1000;reconnectAttempts=0;
    statusDot.className="hd-dot online";
    statusText.textContent="已连接";statusText.className="hd-status connected";
  };
  ws.onclose=()=>{
    statusDot.className="hd-dot offline";
    statusText.textContent="已断开";statusText.className="hd-status";
    const delay=reconnectAttempts<=5?1000:Math.min(reconnectDelay*1.5,10000);
    reconnectAttempts++;
    setTimeout(connect,delay);reconnectDelay=delay;
  };
  ws.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(err){}};
}

function handle(data){
  // Agent status update
  if(data.type==="agent.status"){
    const s=data.payload||{};
    if(s.connected){
      statusDot.className="hd-dot online";
      statusText.textContent=s.deviceName?(s.deviceName+" 在线"):"已连接";
      statusText.className="hd-status connected";
    }else{
      statusDot.className="hd-dot offline";
      statusText.textContent="电脑离线";statusText.className="hd-status";
    }
    return;
  }

  // Chat stream
  if(data.type==="chat.stream"){
    removeThinking();
    if(!isGenerating)setGenerating(true);
    const text=(data.payload&&data.payload.text)||data.text||"";
    if(!text)return;
    if(!streamEl){
      const group=getHerGroup();
      streamEl=document.createElement("div");streamEl.className="md";
      group.appendChild(streamEl);streamBuf="";
    }
    appendStream(text);
    return;
  }

  // Chat response (final)
  if(data.type==="chat.response"){
    removeThinking();finishCmd();
    const reply=(data.payload&&data.payload.reply)||"";
    if(reply&&!streamBuf){
      const group=getHerGroup();
      const el=document.createElement("div");el.className="md";el.innerHTML=md(reply);
      group.appendChild(el);
    }
    endStream();finalizeHerGroup();pendingRequestId=null;
    return;
  }

  // Job result
  if(data.type==="job.result"){
    removeThinking();finishCmd();endStream();
    const group=getHerGroup();
    const el=document.createElement("div");el.className="md";
    el.innerHTML=md(JSON.stringify(data.payload||data,null,2));
    group.appendChild(el);
    finalizeHerGroup();pendingRequestId=null;scrollDown();
    return;
  }

  // Job error
  if(data.type==="job.error"){
    removeThinking();finishCmd();endStream();
    const group=getHerGroup();
    const el=document.createElement("div");el.className="md";el.style.color="#f87171";
    el.textContent=data.error||"请求失败";
    group.appendChild(el);
    finalizeHerGroup();pendingRequestId=null;scrollDown();
    return;
  }
}

// ── Send ──
function updateSendBtn(){
  const has=input.value.trim().length>0;
  sendBtn.disabled=!has;sendBtn.classList.toggle("active",has);
}
function send(text){
  text=(text||input.value).trim();
  if(!text)return;
  if(!ws||ws.readyState!==WebSocket.OPEN){toast("未连接");return}

  finalizeHerGroup();endStream();
  if(welcomeEl)welcomeEl.style.display="none";

  maybeAddTs();
  const msg=document.createElement("div");msg.className="msg msg-user";
  const bubble=document.createElement("div");bubble.className="bubble";
  bubble.textContent=text;msg.appendChild(bubble);
  msgList.appendChild(msg);scrollDown();

  // Show thinking dots
  const group=getHerGroup();
  const dots=document.createElement("div");dots.className="thinking";
  dots.innerHTML="<span></span><span></span><span></span>";
  group.appendChild(dots);thinkingEl=dots;scrollDown();
  setGenerating(true);

  pendingRequestId=crypto.randomUUID();
  ws.send(JSON.stringify({type:"chat.request",requestId:pendingRequestId,payload:{message:text}}));

  input.value="";input.style.height="auto";
  sendBtn.disabled=true;sendBtn.classList.remove("active");
}

function stopGeneration(){
  if(!isGenerating)return;
  if(pendingRequestId&&ws&&ws.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:"cancel",requestId:pendingRequestId}));
  }
  removeThinking();endStream();finalizeHerGroup();setGenerating(false);pendingRequestId=null;
}

sendBtn.addEventListener("click",()=>{if(isGenerating)stopGeneration();else send()});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}});
input.addEventListener("input",()=>{input.style.height="auto";input.style.height=Math.min(input.scrollHeight,120)+"px";updateSendBtn()});
document.querySelectorAll(".chip").forEach(c=>c.addEventListener("click",()=>send(c.dataset.msg)));
document.getElementById("newChatBtn").addEventListener("click",()=>{
  if(confirm("开始新对话？")){
    finalizeHerGroup();endStream();removeThinking();currentCmd=null;
    msgList.innerHTML="";lastMsgTs=0;
    const wel=document.createElement("div");wel.className="welcome";wel.id="welcome";
    wel.innerHTML='<div class="welcome-icon"><span>H</span></div><h2>Hey, I\\'m Her</h2><p>你的 AI 伙伴 — 随时随地，什么都能帮。</p><div class="welcome-chips"><div class="chip" data-msg="你好呀">聊聊天</div><div class="chip" data-msg="今天有什么安排？">今日安排</div><div class="chip" data-msg="帮我总结一下今天做了什么">今日小结</div><div class="chip" data-msg="记住我的名字">记住我</div></div>';
    wel.querySelectorAll(".chip").forEach(c=>c.addEventListener("click",()=>send(c.dataset.msg)));
    msgList.appendChild(wel);
    toast("对话已清空");
  }
});

// PWA hint
if(!window.navigator.standalone&&!window.matchMedia('(display-mode:standalone)').matches){
  document.getElementById("addHomeHint").style.display="block";
}

connect();
</script>
</body></html>`);
});

// ── (Removed iOS .shortcut plist generators — iOS requires signed files) ──
// iPhone users use the /shortcuts PWA page instead.

function _removed_buildIOSShortcut(name, relay, token) {
  const chatUrl = `${relay}/api/shortcut/chat`;
  const todayUrl = `${relay}/api/shortcut/today`;
  const authHeader = `Bearer ${token}`;

  const templates = {
    ask: {
      displayName: "问 Her",
      actions: [
        askForInputAction("想对 Her 说什么？"),
        httpPostAction(chatUrl, authHeader, '{"message":"<INPUT>"}'),
        getDictValueAction("reply"),
        showResultAction(),
      ],
    },
    remember: {
      displayName: "记住一件事",
      actions: [
        askForInputAction("让 Her 记住什么？"),
        httpPostAction(`${relay}/api/shortcut/remember`, authHeader, '{"text":"<INPUT>"}'),
        getDictValueAction("reply"),
        showResultAction(),
      ],
    },
    today: {
      displayName: "今日安排",
      actions: [
        httpPostAction(todayUrl, authHeader, '{}'),
        getDictValueAction("todos"),
        showResultAction(),
      ],
    },
    voice: {
      displayName: "语音问 Her",
      actions: [
        dictateTextAction(),
        httpPostAction(chatUrl, authHeader, '{"message":"<INPUT>"}'),
        getDictValueAction("reply"),
        speakTextAction(),
      ],
    },
    clipboard: {
      displayName: "剪贴板发给 Her",
      actions: [
        getClipboardAction(),
        httpPostAction(chatUrl, authHeader, '{"message":"<INPUT>"}'),
        getDictValueAction("reply"),
        showResultAction(),
      ],
    },
  };

  const tmpl = templates[name];
  if (!tmpl) return null;

  const actionsXml = tmpl.actions.join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>
${actionsXml}
  </array>
  <key>WFWorkflowClientVersion</key>
  <string>2302.0.4</string>
  <key>WFWorkflowHasOutputFallback</key>
  <false/>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconGlyphNumber</key>
    <integer>59771</integer>
    <key>WFWorkflowIconStartColor</key>
    <integer>4282601983</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key>
  <array/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array><string>WFStringContentItem</string></array>
  <key>WFWorkflowMinimumClientVersion</key>
  <integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key>
  <string>900</string>
  <key>WFWorkflowName</key>
  <string>${tmpl.displayName}</string>
  <key>WFWorkflowOutputContentItemClasses</key>
  <array/>
  <key>WFWorkflowTypes</key>
  <array><string>NCWidget</string><string>WatchKit</string></array>
</dict>
</plist>`;

  return plist;
}

function askForInputAction(prompt) {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.ask</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFAskActionPrompt</key>
        <string>${prompt}</string>
        <key>WFInputType</key>
        <string>Text</string>
      </dict>
    </dict>`;
}

function dictateTextAction() {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.dictatetext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFSpeechLanguage</key>
        <string>zh_CN</string>
      </dict>
    </dict>`;
}

function getClipboardAction() {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.getclipboard</string>
      <key>WFWorkflowActionParameters</key>
      <dict/>
    </dict>`;
}

function httpPostAction(url, authHeader, bodyTemplate) {
  // The body uses <INPUT> as placeholder for "Shortcut Input" variable
  // In actual Shortcuts, this would reference the previous action's output
  // For plist, we use WFTextActionText with variable attachment
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFURL</key>
        <string>${url}</string>
        <key>WFHTTPMethod</key>
        <string>POST</string>
        <key>WFHTTPHeaders</key>
        <dict>
          <key>Value</key>
          <array>
            <dict>
              <key>WFDictionaryFieldValueString</key>
              <string>${authHeader}</string>
              <key>WFHTTPHeaderKey</key>
              <string>Authorization</string>
            </dict>
            <dict>
              <key>WFDictionaryFieldValueString</key>
              <string>application/json</string>
              <key>WFHTTPHeaderKey</key>
              <string>Content-Type</string>
            </dict>
          </array>
        </dict>
        <key>WFHTTPBodyType</key>
        <string>Json</string>
        <key>WFJSONValues</key>
        <dict>
          <key>Value</key>
          <array>
            <dict>
              <key>WFDictionaryFieldValueString</key>
              <dict>
                <key>Value</key>
                <dict>
                  <key>attachmentsByRange</key>
                  <dict>
                    <key>{0, 1}</key>
                    <dict>
                      <key>Type</key>
                      <string>ExtensionInput</string>
                    </dict>
                  </dict>
                  <key>string</key>
                  <string>￼</string>
                </dict>
                <key>WFSerializationType</key>
                <string>WFTextTokenString</string>
              </dict>
              <key>WFDictionaryFieldKey</key>
              <string>message</string>
            </dict>
          </array>
        </dict>
      </dict>
    </dict>`;
}

function getDictValueAction(key) {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.getvalueforkey</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFDictionaryKey</key>
        <string>${key}</string>
      </dict>
    </dict>`;
}

function showResultAction() {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.showresult</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Text</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>attachmentsByRange</key>
            <dict>
              <key>{0, 1}</key>
              <dict>
                <key>Type</key>
                <string>ExtensionInput</string>
              </dict>
            </dict>
            <key>string</key>
            <string>￼</string>
          </dict>
          <key>WFSerializationType</key>
          <string>WFTextTokenString</string>
        </dict>
      </dict>
    </dict>`;
}

function speakTextAction() {
  return `    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.speaktext</string>
      <key>WFWorkflowActionParameters</key>
      <dict/>
    </dict>`;
}

// ── Shortcuts REST API ───────────────────────────────────────────────
// Synchronous HTTP endpoints for Apple Shortcuts / Siri / automation.
// All endpoints require Authorization: Bearer <clientToken>

function authenticateShortcut(req, res) {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Missing Authorization header" });
    return null;
  }
  const tokenInfo = tokenMap.get(token);
  if (!tokenInfo) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
  const room = rooms.get(tokenInfo.pairId);
  if (!room) {
    res.status(404).json({ error: "No paired device found" });
    return null;
  }
  if (!room.agentSocket || room.agentSocket.readyState !== WebSocket.OPEN) {
    res.status(503).json({ error: "Her is offline on your computer" });
    return null;
  }
  return room;
}

function sendToAgentAndWait(room, message, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      room.pendingRequests.delete(requestId);
      reject(new Error("Request timed out"));
    }, timeoutMs);

    // Create a virtual "client" that resolves the promise on final response
    const virtualClient = {
      readyState: WebSocket.OPEN,
      send(data) {
        try {
          const parsed = JSON.parse(data);
          // Ignore streaming chunks — only resolve on final response
          if (parsed.type === "chat.stream") return;
          clearTimeout(timer);
          room.pendingRequests.delete(requestId);
          if (parsed.type === "job.error") {
            reject(new Error(parsed.error || "Request failed"));
          } else {
            resolve(parsed.payload || parsed);
          }
        } catch (_) {
          clearTimeout(timer);
          room.pendingRequests.delete(requestId);
          resolve(data);
        }
      },
    };

    room.pendingRequests.set(requestId, { ws: virtualClient, createdAt: Date.now() });
    sendJson(room.agentSocket, { ...message, requestId });
  });
}

// Chat — send a message to Her, get a text reply
app.post("/api/shortcut/chat", async (req, res) => {
  const room = authenticateShortcut(req, res);
  if (!room) return;
  const { message, model } = req.body || {};
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    const result = await sendToAgentAndWait(room, {
      type: "chat.request",
      payload: { message, model },
    });
    res.json({ ok: true, reply: result.reply || "", usage: result.usage || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Today — get today's timeline and todos
app.post("/api/shortcut/today", async (req, res) => {
  const room = authenticateShortcut(req, res);
  if (!room) return;
  try {
    const result = await sendToAgentAndWait(room, {
      type: "job.request",
      action: "timeline.today",
      payload: { limit: req.body.limit || 10 },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Context — what's happening on the user's computer right now
app.post("/api/shortcut/context", async (req, res) => {
  const room = authenticateShortcut(req, res);
  if (!room) return;
  try {
    const result = await sendToAgentAndWait(room, {
      type: "job.request",
      action: "context.current",
      payload: {},
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory — ask Her to remember something
app.post("/api/shortcut/remember", async (req, res) => {
  const room = authenticateShortcut(req, res);
  if (!room) return;
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const result = await sendToAgentAndWait(room, {
      type: "chat.request",
      payload: { message: `请记住这件事：${text}` },
    });
    res.json({ ok: true, reply: result.reply || "已记住" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick action — generic shortcut endpoint, action in body
app.post("/api/shortcut/action", async (req, res) => {
  const room = authenticateShortcut(req, res);
  if (!room) return;
  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ error: "action is required" });
  try {
    const result = await sendToAgentAndWait(room, {
      type: "job.request",
      action,
      payload: payload || {},
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket upgrade ────────────────────────────────────────────────

server.on("upgrade", (req, socket, head) => {
  const parsed = new URL(req.url, "http://localhost");
  const pathname = parsed.pathname;
  const token = parseToken(req.url, req);

  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const tokenInfo = tokenMap.get(token);
  if (!tokenInfo) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const { pairId, role } = tokenInfo;

  if (pathname === "/ws/agent" && role === "agent") {
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      ws._pairId = pairId;
      agentWss.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/ws/client" && role === "client") {
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      ws._pairId = pairId;
      clientWss.emit("connection", ws, req);
    });
    return;
  }

  socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
  socket.destroy();
});

// ── Agent connections ────────────────────────────────────────────────

agentWss.on("connection", (ws, req) => {
  const pairId = ws._pairId;
  let room = rooms.get(pairId);
  if (!room) {
    room = createRoom(pairId);
    rooms.set(pairId, room);
  }

  // Replace existing agent
  if (room.agentSocket && room.agentSocket !== ws && room.agentSocket.readyState === WebSocket.OPEN) {
    try { room.agentSocket.close(4000, "Replaced by newer agent"); } catch (_) {}
  }

  room.agentSocket = ws;
  room.lastActivity = Date.now();
  room.agentStatus = {
    ...room.agentStatus,
    connected: true,
    deviceName: req.headers["x-her-device-name"] || room.agentStatus.deviceName || "",
    connectedAt: now(),
    updatedAt: now(),
  };
  broadcastStatus(room);

  ws.on("message", (raw) => {
    room.lastActivity = Date.now();
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "agent.hello") {
      room.agentStatus = {
        ...room.agentStatus,
        connected: true,
        deviceName: message.payload && message.payload.deviceName ? message.payload.deviceName : room.agentStatus.deviceName,
        ...(message.payload && message.payload.status ? message.payload.status : {}),
        updatedAt: now(),
      };
      broadcastStatus(room);
      return;
    }

    if (message.type === "agent.status") {
      room.agentStatus = {
        ...room.agentStatus,
        connected: true,
        ...(message.payload || {}),
        updatedAt: now(),
      };
      broadcastStatus(room);
      return;
    }

    if (message.type === "chat.stream") {
      const requestId = message.requestId || "";
      const pending = room.pendingRequests.get(requestId);
      if (!pending) return;
      sendJson(pending.ws, message);
      return;
    }

    if (message.type === "chat.response" || message.type === "job.result" || message.type === "job.error") {
      const requestId = message.requestId || "";
      const pending = room.pendingRequests.get(requestId);
      if (!pending) return;
      sendJson(pending.ws, message);
      room.pendingRequests.delete(requestId);
    }
  });

  ws.on("close", () => {
    if (room.agentSocket === ws) {
      room.agentSocket = null;
      room.lastActivity = Date.now();
      room.agentStatus = {
        ...room.agentStatus,
        connected: false,
        updatedAt: now(),
      };
      broadcastStatus(room);
      failPendingRequests(room, "Her on your computer is offline.");
    }
  });
});

// ── Client connections ───────────────────────────────────────────────

clientWss.on("connection", (ws) => {
  const pairId = ws._pairId;
  let room = rooms.get(pairId);
  if (!room) {
    room = createRoom(pairId);
    rooms.set(pairId, room);
  }

  room.clients.add(ws);
  room.lastActivity = Date.now();

  sendJson(ws, {
    type: "agent.status",
    payload: buildAgentStatusPayload(room),
  });

  ws.on("message", (raw) => {
    room.lastActivity = Date.now();
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "agent.status") {
      sendJson(ws, {
        type: "agent.status",
        payload: buildAgentStatusPayload(room),
      });
      return;
    }

    if (message.type !== "chat.request" && message.type !== "job.request") return;

    if (!room.agentSocket || room.agentSocket.readyState !== WebSocket.OPEN) {
      sendJson(ws, {
        type: "job.error",
        requestId: message.requestId || "",
        error: "Her on your computer is offline.",
      });
      return;
    }

    const requestId = message.requestId || crypto.randomUUID();
    room.pendingRequests.set(requestId, { ws, createdAt: Date.now() });
    sendJson(room.agentSocket, {
      ...message,
      requestId,
    });
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    room.lastActivity = Date.now();
    for (const [requestId, pending] of room.pendingRequests.entries()) {
      if (pending.ws === ws) room.pendingRequests.delete(requestId);
    }
  });
});

// ── Start ────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[relay] multi-user relay listening on http://0.0.0.0:${PORT}`);
  console.log(`[relay] rooms will expire after ${ROOM_TTL_MS / 1000 / 3600}h of inactivity`);
});
