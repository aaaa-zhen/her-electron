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
