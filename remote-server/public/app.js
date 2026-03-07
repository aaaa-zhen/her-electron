const authCard = document.getElementById("authCard");
const workspace = document.getElementById("workspace");
const tokenInput = document.getElementById("tokenInput");
const connectBtn = document.getElementById("connectBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const input = document.getElementById("input");

let socket = null;
const pending = new Map();

function createRequestId() {
  const webCrypto = window.crypto || window.msCrypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function restoreToken() {
  const saved = localStorage.getItem("herRemoteClientToken") || "";
  tokenInput.value = saved;
}

function saveToken(token) {
  localStorage.setItem("herRemoteClientToken", token);
}

function wsUrl(token) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/client?token=${encodeURIComponent(token)}`;
}

function setStatus(text, online) {
  statusText.textContent = text;
  statusDot.classList.toggle("online", Boolean(online));
  statusDot.classList.toggle("offline", !online);
}

function appendBubble(role, html) {
  const item = document.createElement("div");
  item.className = `bubble ${role}`;
  item.innerHTML = html;
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return item;
}

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function connect() {
  const token = tokenInput.value.trim();
  if (!token) return;

  saveToken(token);
  if (socket) {
    socket.close();
    socket = null;
  }

  setStatus("连接中...", false);
  socket = new WebSocket(wsUrl(token));

  socket.addEventListener("open", () => {
    authCard.classList.add("hidden");
    workspace.classList.remove("hidden");
    setStatus("已连接 relay", false);
    appendBubble("assistant", "<p>手机端连上了。等 Mac 上的 Her Agent 在线，就能直接走同一个 Her。</p>");
    socket.send(JSON.stringify({ type: "agent.status" }));
  });

  socket.addEventListener("close", () => {
    setStatus("已断开", false);
  });

  socket.addEventListener("message", (event) => {
    let message = null;
    try {
      message = JSON.parse(String(event.data || ""));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "agent.status") {
      const payload = message.payload || {};
      const text = payload.connected
        ? `Mac 在线${payload.deviceName ? ` · ${payload.deviceName}` : ""}`
        : "Mac 离线";
      setStatus(text, payload.connected);
      return;
    }

    if (message.type === "chat.response") {
      const slot = pending.get(message.requestId);
      if (slot) {
        slot.innerHTML = `<p>${esc((message.payload && message.payload.reply) || "")}</p>`;
        pending.delete(message.requestId);
      }
      return;
    }

    if (message.type === "job.result") {
      const slot = pending.get(message.requestId);
      if (slot) {
        slot.innerHTML = renderJobResult(message.payload || {});
        pending.delete(message.requestId);
      }
      return;
    }

    if (message.type === "job.error") {
      const slot = pending.get(message.requestId);
      const html = `<p class="error">${esc(message.error || "请求失败")}</p>`;
      if (slot) {
        slot.innerHTML = html;
        pending.delete(message.requestId);
      } else {
        appendBubble("assistant", html);
      }
    }
  });
}

function renderJobResult(payload) {
  if (!payload || typeof payload !== "object") return "<p>没有结果</p>";

  if (payload.action === "timeline.today") {
    const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    const todos = Array.isArray(payload.todos) ? payload.todos : [];
    const blocks = [];
    if (timeline.length > 0) {
      blocks.push("<h3>今天时间线</h3>");
      blocks.push(`<ul>${timeline.map((item) => `<li><strong>${esc(item.title)}</strong>${item.at ? ` · ${esc(item.at.slice(11, 16))}` : ""}${item.detail ? `<br><span>${esc(item.detail)}</span>` : ""}</li>`).join("")}</ul>`);
    }
    if (todos.length > 0) {
      blocks.push("<h3>今天待办</h3>");
      blocks.push(`<ul>${todos.map((item) => `<li><strong>${esc(item.title)}</strong>${item.dueDate ? ` · ${esc(item.dueDate)}` : ""}</li>`).join("")}</ul>`);
    }
    return blocks.join("") || "<p>今天还没有抓到明确的 timeline。</p>";
  }

  if (payload.action === "context.current") {
    const context = payload.context || {};
    const page = context.currentPage;
    const calendar = Array.isArray(context.calendar) ? context.calendar : [];
    const todos = Array.isArray(context.activeTodos) ? context.activeTodos : [];
    return `
      <h3>当前上下文</h3>
      <p><strong>前台 App：</strong>${esc(context.frontApp || "未知")}</p>
      <p><strong>当前页面：</strong>${page ? esc(page.title || page.url || "已识别到页面") : "暂无"}</p>
      ${page && page.url ? `<p class="muted">${esc(page.url)}</p>` : ""}
      ${calendar.length > 0 ? `<p><strong>近期待程：</strong>${esc(calendar.map((item) => item.title).join("；"))}</p>` : ""}
      ${todos.length > 0 ? `<p><strong>待办：</strong>${esc(todos.map((item) => item.title).join("；"))}</p>` : ""}
    `;
  }

  if (payload.action === "artifact.recall") {
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    if (artifacts.length === 0) return "<p>最近没找到可回传的文件。</p>";
    return `
      <h3>最近文件</h3>
      <ul>${artifacts.map((item) => `<li><strong>${esc(item.filename)}</strong>${item.sizeLabel ? ` · ${esc(item.sizeLabel)}` : ""}<br><span>${esc(item.detail || "")}</span></li>`).join("")}</ul>
    `;
  }

  if (payload.action === "media.download") {
    return `
      <h3>下载结果</h3>
      <p>${esc(payload.result || "完成")}</p>
      ${payload.artifact ? `<p><strong>${esc(payload.artifact.filename)}</strong>${payload.artifact.sizeLabel ? ` · ${esc(payload.artifact.sizeLabel)}` : ""}</p>` : ""}
    `;
  }

  return `<pre>${esc(JSON.stringify(payload, null, 2))}</pre>`;
}

connectBtn.addEventListener("click", connect);

tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connect();
});

document.querySelectorAll("[data-job]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const action = button.getAttribute("data-job");
    const requestId = createRequestId();
    let payload = {};
    if (action === "artifact.recall") payload = { limit: 6 };
    socket.send(JSON.stringify({
      type: "job.request",
      requestId,
      action,
      payload,
    }));
    const bubble = appendBubble("assistant", "<p class=\"muted\">处理中...</p>");
    pending.set(requestId, bubble);
  });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

  appendBubble("user", `<p>${esc(text)}</p>`);
  input.value = "";
  const requestId = createRequestId();
  socket.send(JSON.stringify({
    type: "chat.request",
    requestId,
    payload: {
      message: text,
    },
  }));
  const bubble = appendBubble("assistant", "<p class=\"muted\">Her 正在想...</p>");
  pending.set(requestId, bubble);
});

restoreToken();
