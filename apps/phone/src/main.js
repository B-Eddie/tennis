import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const SERVER_URL = `${wsProtocol}://${window.location.host}/socket`;
const connectBtn = document.querySelector("#connectBtn");
const statusEl = document.querySelector("#status");
const statsEl = document.querySelector("#stats");
const sessionInfoEl = document.querySelector("#sessionInfo");
const permissionModalEl = document.querySelector("#permissionModal");
const enableSensorsBtn = document.querySelector("#enableSensorsBtn");
const maybeLaterBtn = document.querySelector("#maybeLaterBtn");
const sessionId = new URLSearchParams(window.location.search).get("session");

let ws;
let latestOrientation = { alpha: 0, beta: 0, gamma: 0 };
let latestMotion = { x: 0, y: 0, z: 0 };
let streamInterval;
let isLoggingSession = false;
let isStreaming = false;
let orientationEventCount = 0;
let motionEventCount = 0;
let lastSensorEventAt = 0;
let sensorHealthTimeout;

async function ensureSensorPermissions() {
  if (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  ) {
    const motionPermission = await DeviceMotionEvent.requestPermission();
    if (motionPermission !== "granted") throw new Error("Motion permission denied");
  }

  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    const orientationPermission = await DeviceOrientationEvent.requestPermission();
    if (orientationPermission !== "granted") throw new Error("Orientation permission denied");
  }
}

function needsGesturePermissionFlow() {
  return (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  );
}

function openPermissionPrompt() {
  permissionModalEl.classList.remove("hidden");
}

function closePermissionPrompt() {
  permissionModalEl.classList.add("hidden");
}

function connectSocket() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", role: "phone", sessionId }));
    statusEl.textContent = "Connected. Streaming sensor data...";
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected. Tap button to reconnect.";
    clearInterval(streamInterval);
    isLoggingSession = false;
    isStreaming = false;
  };

  ws.onerror = () => {
    statusEl.textContent =
      "Socket failed. Make sure phone and computer are on same network.";
  };
}

function startStreaming() {
  if (isStreaming) return;
  isStreaming = true;

  window.addEventListener("deviceorientation", (event) => {
    orientationEventCount += 1;
    lastSensorEventAt = Date.now();
    latestOrientation = {
      alpha: event.alpha ?? 0,
      beta: event.beta ?? 0,
      gamma: event.gamma ?? 0
    };
  });

  window.addEventListener("devicemotion", (event) => {
    motionEventCount += 1;
    lastSensorEventAt = Date.now();
    latestMotion = {
      x: event.accelerationIncludingGravity?.x ?? 0,
      y: event.accelerationIncludingGravity?.y ?? 0,
      z: event.accelerationIncludingGravity?.z ?? 0
    };
  });

  clearTimeout(sensorHealthTimeout);
  sensorHealthTimeout = setTimeout(() => {
    if (lastSensorEventAt === 0) {
      statusEl.textContent =
        "Connected, but no sensor events received. On iPhone: Settings > Safari > Motion & Orientation Access must be ON.";
    }
  }, 3000);

  streamInterval = setInterval(async () => {
    const payload = { orientation: latestOrientation, motion: latestMotion };
    const debug = {
      sessionId,
      secureContext: window.isSecureContext,
      orientationEvents: orientationEventCount,
      motionEvents: motionEventCount,
      payload
    };
    statsEl.textContent = JSON.stringify(debug, null, 2);

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "controller-state", payload }));
    }

    if (!isLoggingSession) {
      isLoggingSession = true;
      try {
        await addDoc(collection(db, "controller_sessions"), {
          createdAt: serverTimestamp(),
          deviceInfo: navigator.userAgent
        });
      } catch (err) {
        console.error("Failed to write Firebase session:", err);
      }
    }
  }, 50);
}

connectBtn.addEventListener("click", async () => {
  if (!sessionId) {
    statusEl.textContent =
      "Missing session in URL. Use the special link shown on the game screen.";
    return;
  }

  try {
    await ensureSensorPermissions();
    connectSocket();
  } catch (err) {
    statusEl.textContent = `Permission/connect error: ${err.message}`;
  }
});

enableSensorsBtn.addEventListener("click", async () => {
  try {
    await ensureSensorPermissions();
    statusEl.textContent = "Sensor access enabled. Tap connect when ready.";
    closePermissionPrompt();
  } catch (err) {
    statusEl.textContent = `Permission error: ${err.message}`;
  }
});

maybeLaterBtn.addEventListener("click", () => {
  closePermissionPrompt();
  statusEl.textContent = "You can enable sensors later by tapping connect.";
});

if (sessionId) {
  sessionInfoEl.textContent = `Session: ${sessionId} | Server: ${SERVER_URL}`;
} else {
  sessionInfoEl.textContent =
    "No session found. Open this page from the special game link.";
}

if (needsGesturePermissionFlow()) {
  openPermissionPrompt();
}
