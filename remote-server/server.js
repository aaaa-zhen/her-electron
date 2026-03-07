const crypto = require("crypto");
const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.HER_RELAY_PORT || 3939);
const AGENT_TOKEN = process.env.HER_RELAY_AGENT_TOKEN || process.env.HER_RELAY_ACCESS_TOKEN || "dev-agent-token";
const CLIENT_TOKEN = process.env.HER_RELAY_CLIENT_TOKEN || process.env.HER_RELAY_ACCESS_TOKEN || "dev-client-token";

const app = express();
const server = http.createServer(app);
const agentWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

let agentSocket = null;
let lastAgentStatus = {
  connected: false,
  deviceName: "",
  capabilities: [],
  updatedAt: null,
};

const clients = new Set();
const pendingRequests = new Map();

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

function buildAgentStatusPayload() {
  return {
    connected: Boolean(agentSocket && agentSocket.readyState === WebSocket.OPEN),
    ...lastAgentStatus,
    connectedAt: lastAgentStatus.connectedAt || null,
    updatedAt: now(),
  };
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastStatus() {
  const payload = {
    type: "agent.status",
    payload: buildAgentStatusPayload(),
  };
  for (const client of clients) {
    sendJson(client, payload);
  }
}

function failPendingRequests(message) {
  for (const [requestId, pending] of pendingRequests.entries()) {
    sendJson(pending.ws, {
      type: "job.error",
      requestId,
      error: message,
    });
    pendingRequests.delete(requestId);
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    agent: buildAgentStatusPayload(),
    pendingRequests: pendingRequests.size,
    clients: clients.size,
  });
});

app.get("/api/status", (_req, res) => {
  res.json(buildAgentStatusPayload());
});

server.on("upgrade", (req, socket, head) => {
  const parsed = new URL(req.url, "http://localhost");
  const pathname = parsed.pathname;
  const token = parseToken(req.url, req);

  if (pathname === "/ws/agent") {
    if (token !== AGENT_TOKEN) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    agentWss.handleUpgrade(req, socket, head, (ws) => {
      agentWss.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === "/ws/client") {
    if (token !== CLIENT_TOKEN) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      clientWss.emit("connection", ws, req);
    });
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

agentWss.on("connection", (ws, req) => {
  if (agentSocket && agentSocket !== ws && agentSocket.readyState === WebSocket.OPEN) {
    try {
      agentSocket.close(4000, "Replaced by newer agent");
    } catch (_) {}
  }

  agentSocket = ws;
  lastAgentStatus = {
    ...lastAgentStatus,
    connected: true,
    deviceName: req.headers["x-her-device-name"] || lastAgentStatus.deviceName || "",
    connectedAt: now(),
    updatedAt: now(),
  };
  broadcastStatus();

  ws.on("message", (raw) => {
    let message = null;
    try {
      message = JSON.parse(String(raw || ""));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "agent.hello") {
      lastAgentStatus = {
        ...lastAgentStatus,
        connected: true,
        deviceName: message.payload && message.payload.deviceName ? message.payload.deviceName : lastAgentStatus.deviceName,
        ...(message.payload && message.payload.status ? message.payload.status : {}),
        updatedAt: now(),
      };
      broadcastStatus();
      return;
    }

    if (message.type === "agent.status") {
      lastAgentStatus = {
        ...lastAgentStatus,
        connected: true,
        ...(message.payload || {}),
        updatedAt: now(),
      };
      broadcastStatus();
      return;
    }

    if (message.type === "chat.stream") {
      const requestId = message.requestId || "";
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      sendJson(pending.ws, message);
      return;
    }

    if (message.type === "chat.response" || message.type === "job.result" || message.type === "job.error") {
      const requestId = message.requestId || "";
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      sendJson(pending.ws, message);
      pendingRequests.delete(requestId);
    }
  });

  ws.on("close", () => {
    if (agentSocket === ws) {
      agentSocket = null;
      lastAgentStatus = {
        ...lastAgentStatus,
        connected: false,
        updatedAt: now(),
      };
      broadcastStatus();
      failPendingRequests("Her on Mac is offline.");
    }
  });
});

clientWss.on("connection", (ws) => {
  clients.add(ws);
  sendJson(ws, {
    type: "agent.status",
    payload: buildAgentStatusPayload(),
  });

  ws.on("message", (raw) => {
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
        payload: buildAgentStatusPayload(),
      });
      return;
    }

    if (message.type !== "chat.request" && message.type !== "job.request") return;

    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      sendJson(ws, {
        type: "job.error",
        requestId: message.requestId || "",
        error: "Her on Mac is offline.",
      });
      return;
    }

    const requestId = message.requestId || crypto.randomUUID();
    pendingRequests.set(requestId, { ws, createdAt: Date.now() });
    sendJson(agentSocket, {
      ...message,
      requestId,
    });
  });

  ws.on("close", () => {
    clients.delete(ws);
    for (const [requestId, pending] of pendingRequests.entries()) {
      if (pending.ws === ws) pendingRequests.delete(requestId);
    }
  });
});

server.listen(PORT, () => {
  if (AGENT_TOKEN === "dev-agent-token" || CLIENT_TOKEN === "dev-client-token") {
    console.warn("[relay] Using development tokens. Set HER_RELAY_AGENT_TOKEN and HER_RELAY_CLIENT_TOKEN before exposing this server.");
  }
  console.log(`[relay] listening on http://0.0.0.0:${PORT}`);
});
