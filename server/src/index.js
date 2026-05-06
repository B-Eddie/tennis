import { WebSocketServer } from "ws";

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

const sessions = new Map();

function safeSend(client, data) {
  if (client && client.readyState === 1) {
    client.send(JSON.stringify(data));
  }
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { gameClient: null, phoneClient: null });
  }
  return sessions.get(sessionId);
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.gameClient && !session.phoneClient) {
    sessions.delete(sessionId);
  }
}

wss.on("connection", (ws) => {
  let wsRole = null;
  let wsSessionId = null;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "register") {
      const sessionId = message.sessionId;
      if (!sessionId || typeof sessionId !== "string") {
        safeSend(ws, { type: "error", message: "Missing valid sessionId" });
        return;
      }

      const session = getOrCreateSession(sessionId);
      wsRole = message.role;
      wsSessionId = sessionId;

      if (message.role === "game") {
        session.gameClient = ws;
      } else if (message.role === "phone") {
        session.phoneClient = ws;
      } else {
        safeSend(ws, { type: "error", message: "Invalid role" });
        return;
      }

      safeSend(session.gameClient, {
        type: "system",
        message: "Controller status updated",
        hasPhone: Boolean(session.phoneClient)
      });
      return;
    }

    if (message.type === "controller-state") {
      if (!wsSessionId) return;
      const session = sessions.get(wsSessionId);
      if (!session) return;
      safeSend(session.gameClient, {
        type: "controller-state",
        payload: message.payload
      });
    }
  });

  ws.on("close", () => {
    if (!wsSessionId || !wsRole) return;
    const session = sessions.get(wsSessionId);
    if (!session) return;

    if (wsRole === "game" && session.gameClient === ws) {
      session.gameClient = null;
    }
    if (wsRole === "phone" && session.phoneClient === ws) {
      session.phoneClient = null;
    }

    safeSend(session.gameClient, {
      type: "system",
      message: "Controller disconnected",
      hasPhone: Boolean(session.phoneClient)
    });
    cleanupSession(wsSessionId);
  });
});

console.log(`WebSocket relay server running on ws://localhost:${PORT}`);
