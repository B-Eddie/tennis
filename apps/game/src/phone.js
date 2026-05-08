import { ref, set, onDisconnect, serverTimestamp } from "firebase/database";
import { rtdb } from "./firebase";
import { onValue } from "firebase/database";

const sessionId = new URLSearchParams(window.location.search).get("session");

let latestOrientation = { alpha: 0, beta: 0, gamma: 0 };
let latestMotion = { x: 0, y: 0, z: 0 };
let latestAcceleration = { x: 0, y: 0, z: 0 };
let latestGyro = { alpha: 0, beta: 0, gamma: 0 };
let isStreaming = false;
let streamInterval;
let orientationEventCount = 0;
let motionEventCount = 0;
let lastSensorEventAt = 0;
let sensorHealthTimeout;

function vibrate() {
  if (navigator.vibrate) {
    navigator.vibrate(100);
  }
}

async function ensureSensorPermissions() {
  if (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  ) {
    const motionPermission = await DeviceMotionEvent.requestPermission();
    if (motionPermission !== "granted")
      throw new Error("Motion permission denied");
  }

  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    const orientationPermission =
      await DeviceOrientationEvent.requestPermission();
    if (orientationPermission !== "granted")
      throw new Error("Orientation permission denied");
  }
}

function needsGesturePermissionFlow() {
  return (
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function"
  );
}

document.addEventListener("DOMContentLoaded", () => {
  const connectBtn = document.querySelector("#connectBtn");
  const statusEl = document.querySelector("#status");
  const statsEl = document.querySelector("#stats");
  const sessionInfoEl = document.querySelector("#sessionInfo");
  const permissionModalEl = document.querySelector("#permissionModal");
  const enableSensorsBtn = document.querySelector("#enableSensorsBtn");
  const maybeLaterBtn = document.querySelector("#maybeLaterBtn");

  async function connectToSession() {
    if (!sessionId) {
      statusEl.textContent =
        "Missing session in URL. Scan the QR code from the game screen.";
      return false;
    }

    try {
      const phoneRef = ref(rtdb, `sessions/${sessionId}/phone`);
      await set(phoneRef, {
        online: true,
        connectedAt: serverTimestamp(),
        device: navigator.userAgent,
      });
      onDisconnect(phoneRef).set({ online: false });
      statusEl.textContent = "Connected via Firebase. Streaming sensor data...";
      onValue(
        ref(rtdb, `sessions/${sessionId}/vibrate`),
        (snapshot) => {
          console.log("Vibrate listener fired:", snapshot.val());
          const data = snapshot.val();
          if (data) {
            console.log("Vibrating...");
            vibrate();
          }
        },
        (error) => {
          console.error("Vibrate listener error:", error);
          statusEl.textContent = `Database read error: ${error.message}`;
        },
      );
      return true;
    } catch (err) {
      statusEl.textContent = `Connect error: ${err.message}`;
      return false;
    }
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
        gamma: event.gamma ?? 0,
      };
    });

    window.addEventListener("devicemotion", (event) => {
      motionEventCount += 1;
      lastSensorEventAt = Date.now();
      latestMotion = {
        x: event.accelerationIncludingGravity?.x ?? 0,
        y: event.accelerationIncludingGravity?.y ?? 0,
        z: event.accelerationIncludingGravity?.z ?? 0,
      };
      latestAcceleration = {
        x: event.acceleration?.x ?? event.accelerationIncludingGravity?.x ?? 0,
        y: event.acceleration?.y ?? event.accelerationIncludingGravity?.y ?? 0,
        z: event.acceleration?.z ?? event.accelerationIncludingGravity?.z ?? 0,
      };
      latestGyro = {
        alpha: event.rotationRate?.alpha ?? 0,
        beta: event.rotationRate?.beta ?? 0,
        gamma: event.rotationRate?.gamma ?? 0,
      };

      latestAcceleration = {
        x: event.acceleration?.x ?? event.accelerationIncludingGravity?.x ?? 0,
        y: event.acceleration?.y ?? event.accelerationIncludingGravity?.y ?? 0,
        z: event.acceleration?.z ?? event.accelerationIncludingGravity?.z ?? 0,
      };
    });

    clearTimeout(sensorHealthTimeout);
    sensorHealthTimeout = setTimeout(() => {
      if (lastSensorEventAt === 0) {
        statusEl.textContent =
          "Connected, but no sensor events received. On iPhone: Settings > Safari > Motion & Orientation Access must be ON.";
      }
    }, 3000);

    const controllerRef = ref(rtdb, `sessions/${sessionId}/controller`);

    function getScreenOrientationDeg() {
      if (typeof screen !== "undefined" && screen.orientation?.angle != null) {
        return screen.orientation.angle;
      }
      if (typeof window.orientation === "number") return window.orientation;
      return 0;
    }

    streamInterval = setInterval(() => {
      const payload = {
        orientation: latestOrientation,
        motion: latestMotion,
        acceleration: latestAcceleration,
        gyro: latestGyro,
        sampleTs: Date.now(),
        screenOrientation: getScreenOrientationDeg(),
      };
      const debug = {
        sessionId,
        secureContext: window.isSecureContext,
        orientationEvents: orientationEventCount,
        motionEvents: motionEventCount,
        payload,
      };
      statsEl.textContent = JSON.stringify(debug, null, 2);

      set(controllerRef, payload).catch((err) => {
        console.error("Failed to write controller state:", err);
      });
    }, 50);
  }

  function openPermissionPrompt() {
    permissionModalEl.classList.remove("hidden");
  }

  function closePermissionPrompt() {
    permissionModalEl.classList.add("hidden");
  }

  connectBtn.addEventListener("click", async () => {
    try {
      await ensureSensorPermissions();
      const ok = await connectToSession();
      if (ok) startStreaming();
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
    sessionInfoEl.textContent = `Session: ${sessionId}`;
  } else {
    sessionInfoEl.textContent =
      "No session found. Scan the QR code from the game screen.";
  }

  if (needsGesturePermissionFlow()) {
    openPermissionPrompt();
  }
});
