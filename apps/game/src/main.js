import * as THREE from "three";
import QRCode from "qrcode";
import {
  onValue,
  ref,
  set,
  onDisconnect,
  serverTimestamp,
} from "firebase/database";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { rtdb } from "./firebase";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";

let gamePaused = true;

const statusEl = document.querySelector("#status");
const joinLinkEl = document.querySelector("#joinLink");
const joinQrEl = document.querySelector("#joinQr");

const sessionId = crypto.randomUUID().slice(0, 8);
const phoneBaseUrl = `${window.location.origin}/phone.html`;
const joinLink = `${phoneBaseUrl}?session=${sessionId}`;
joinLinkEl.href = joinLink;
joinLinkEl.textContent = joinLink;

/** When set, blocks + audio follow analyzed onsets; otherwise endless spawn(). */
let rhythmTrack = null;

/** After "Go!", Firebase must not call `page("gameAlmostStart")` again — it would re-show #hud. */
let firebaseLobbyPageEnabled = true;

/** Wall-clock start of rhythm/endless session (after "Go!"); 0 when not in an active session. */
let gameplayStartedAt = 0;
let savedGameplayElapsedMs = 0;
const rhythmSpawnTimerIds = [];
let endlessSpawnTimerId = null;
let rhythmEndedHooked = false;

let pageMode = "initialState";

/** Each boolean is "show this layer" (not hide). */
function pageHelper(
  showHud,
  showHelpModal,
  showPauseModal,
  showGameFinishModal,
  showJoinContainer,
  showGameContainer,
  showMusicForm,
  showGameTitle,
) {
  const hudEl = document.getElementById("hud");
  if (hudEl) hudEl.style.display = showHud ? "block" : "none";
  const helpEl = document.getElementById("helpModal");
  if (helpEl) helpEl.style.display = showHelpModal ? "flex" : "none";
  const pauseEl = document.getElementById("pauseModal");
  if (pauseEl) pauseEl.style.display = showPauseModal ? "flex" : "none";
  const finishEl = document.getElementById("gameFinish");
  if (finishEl) finishEl.style.display = showGameFinishModal ? "flex" : "none";
  const joinEl = document.getElementById("joinContainer");
  if (joinEl) joinEl.style.display = showJoinContainer ? "block" : "none";
  const gameEl = document.getElementById("gameContainer");
  if (gameEl) gameEl.style.display = showGameContainer ? "block" : "none";
  const musicEl = document.getElementById("musicForm");
  if (musicEl) musicEl.style.display = showMusicForm ? "block" : "none";
  const gameTitle = document.getElementById("gameTitle");
  if (gameTitle) gameTitle.style.display = showGameTitle ? "block" : "none";
}

function page(mode) {
  pageMode = mode;
  if (pageMode === "initialState") {
    pageHelper(true, false, false, false, true, false, true, true);
  } else if (pageMode === "gameStart" || pageMode === "gamestart") {
    // Fullscreen-style play: hide entire HUD overlay
    pageHelper(false, false, false, false, false, false, false, false);
  } else if (pageMode === "gameAlmostStart") {
    // when the game is almost ready to start
    pageHelper(true, false, false, false, false, true, true, false);
  } else if (pageMode === "pause" || pageMode === "pauseModal") {
    pageHelper(true, false, true, false, false, false, false, false);
  } else if (pageMode === "gameFinish") {
    pageHelper(true, false, false, true, false, false, false, false);
  } else if (pageMode === "helpModal") {
    pageHelper(true, true, false, false, false, false, false, false);
  }
}

// qrcode generation
QRCode.toDataURL(joinLink, {
  width: 320,
  margin: 1,
})
  .then((dataUrl) => {
    joinQrEl.src = dataUrl;
  })
  .catch(() => {
    statusEl.textContent = "Could not generate QR code. Use the link below.";
  });

const scene = new THREE.Scene();
scene.background = new THREE.Color("#000");

// camera + controls
const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 4, 2);
camera.lookAt(0, 3, 0); // 0, 1.4, 0

const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());

// click to lock
document.addEventListener("click", () => {
  if (gamePaused) return; // camera can't be locked if the game is paused
  controls.lock();
});

// WASD state
const keys = {
  w: false,
  a: false,
  s: false,
  d: false,
  shift: false,
};

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyW") keys.w = true;
  if (event.code === "KeyA") keys.a = true;
  if (event.code === "KeyS") keys.s = true;
  if (event.code === "KeyD") keys.d = true;
  if (event.code === "ShiftLeft" || event.code === "ShiftRight")
    keys.shift = true;
});

window.addEventListener("keyup", (event) => {
  if (event.code === "KeyW") keys.w = false;
  if (event.code === "KeyA") keys.a = false;
  if (event.code === "KeyS") keys.s = false;
  if (event.code === "KeyD") keys.d = false;
  if (event.code === "ShiftLeft" || event.code === "ShiftRight")
    keys.shift = false;
});

const moveSpeed = 4.0;
const fastSpeed = 8.0;
const forward = new THREE.Vector3();
const right = new THREE.Vector3();

function updateCamera(delta) {
  if (!controls.isLocked) return;

  const speed = keys.shift ? fastSpeed : moveSpeed;
  const amount = speed * delta;

  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  right.set(1, 0, 0).applyQuaternion(camera.quaternion);

  if (keys.w) controls.getObject().position.addScaledVector(forward, amount);
  if (keys.s) controls.getObject().position.addScaledVector(forward, -amount);
  if (keys.d) controls.getObject().position.addScaledVector(right, amount);
  if (keys.a) controls.getObject().position.addScaledVector(right, -amount);
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(3, 5, 2);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.45));

const bgLoader = new GLTFLoader();
bgLoader.load("/assets/scene.glb", (gltf) => {
  const bg = gltf.scene;

  bg.position.set(0, -10, -10);
  bg.rotateY(-Math.PI / 2);
  bg.scale.set(0.5, 0.5, 0.5);

  scene.add(bg);
});

// load in saber model
const SABER_HOME = new THREE.Vector3(0, 1.4, 0);
const loader = new GLTFLoader();

let saberMesh = null;
loader.load("/assets/saber.glb", (gltf) => {
  saberMesh = new THREE.Group();

  gltf.scene.rotation.z = Math.PI / 2;
  gltf.scene.translateX(-1.5);

  // loaded model inside the group
  const bbox = new THREE.Box3().setFromObject(gltf.scene);
  const center = bbox.getCenter(new THREE.Vector3());
  gltf.scene.position.sub(center);

  saberMesh.add(gltf.scene);
  scene.add(saberMesh);
  saberMesh.position.set(SABER_HOME);
});

let phoneState = {
  orientation: { alpha: 0, beta: 0, gamma: 0 },
  gyro: { alpha: 0, beta: 0, gamma: 0 },
  sampleTs: 0,
  screenOrientation: 0,
};

let calibrationInverse = null;

const sessionRef = ref(rtdb, `sessions/${sessionId}`);
const controllerRef = ref(rtdb, `sessions/${sessionId}/controller`);

set(ref(rtdb, `sessions/${sessionId}/game`), {
  createdAt: serverTimestamp(),
  online: true,
})
  .then(() => {
    statusEl.textContent = "Session ready. Waiting for phone to scan QR...";
    onDisconnect(sessionRef).remove();
  })
  .catch((err) => {
    statusEl.textContent = `Could not create session: ${err.message}`;
  });

onValue(controllerRef, (snapshot) => {
  const data = snapshot.val();
  if (!data) return;
  phoneState = {
    orientation: data.orientation ?? phoneState.orientation,
    gyro: data.gyro ?? phoneState.gyro,
    sampleTs: data.sampleTs ?? phoneState.sampleTs,
    screenOrientation: data.screenOrientation ?? phoneState.screenOrientation,
  };
  if (firebaseLobbyPageEnabled) {
    page("gameAlmostStart");
  }
});

// recallibrate
window.addEventListener("keydown", (event) => {
  if (event.key === "c" || event.key === "C") {
    calibrationInverse = null;
  } else if (event.key === "?" || event.key === "?") {
    if (pageMode === "helpModal") {
      // Restore the page to the one we were on before showing helpModal
      if (window.previousPageMode && window.previousPageMode !== "helpModal") {
        page(window.previousPageMode);
      }
    } else {
      // Save the current page to restore after helpModal
      window.previousPageMode = pageMode;
      page("helpModal");
    }
  } else if (event.key === "p" || event.key === "P") {
    if (pageMode !== "initialState") {
      if (gamePaused) {
        page("gameStart");
        gamePaused = false;
        if (gameplayStartedAt) {
          gameplayStartedAt = performance.now() - savedGameplayElapsedMs;
          if (rhythmTrack) scheduleRhythmFromElapsed(savedGameplayElapsedMs);
          else spawn();
        }
      } else {
        if (
          (pageMode === "gameStart" || pageMode === "gamestart") &&
          gameplayStartedAt
        ) {
          savedGameplayElapsedMs = performance.now() - gameplayStartedAt;
          for (const id of rhythmSpawnTimerIds) clearTimeout(id);
          rhythmSpawnTimerIds.length = 0;
          if (rhythmTrack) rhythmTrack.audio.pause();
          if (endlessSpawnTimerId) {
            clearTimeout(endlessSpawnTimerId);
            endlessSpawnTimerId = null;
          }
        }
        page("pauseModal");
        gamePaused = true;
      }
    }
  }
});

let lastTime = performance.now() / 1000;

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _phoneQuat = new THREE.Quaternion();
const _targetQuat = new THREE.Quaternion();

function quaternionFromDeviceOrientation(
  quat,
  alphaDeg,
  betaDeg,
  gammaDeg,
  screenDeg,
) {
  const alpha = THREE.MathUtils.degToRad(alphaDeg || 0);
  const beta = THREE.MathUtils.degToRad(betaDeg || 0);
  const gamma = THREE.MathUtils.degToRad(gammaDeg || 0);
  const orient = THREE.MathUtils.degToRad(screenDeg || 0);

  _euler.set(beta, alpha, -gamma, "YXZ");
  quat.setFromEuler(_euler);
  quat.multiply(_q1);
  quat.multiply(_q0.setFromAxisAngle(_zee, -orient));
}

function updateRacketFromPhone() {
  if (!saberMesh) return;
  const { alpha, beta, gamma } = phoneState.orientation;
  const screen = phoneState.screenOrientation;

  quaternionFromDeviceOrientation(_phoneQuat, alpha, beta, gamma, screen);

  if (!calibrationInverse) {
    calibrationInverse = _phoneQuat.clone().invert();
  }

  _targetQuat.copy(calibrationInverse).multiply(_phoneQuat);
  saberMesh.quaternion.slerp(_targetQuat, 0.35);
  saberMesh.position.copy(SABER_HOME);
}

// =========== block spawning ============
const blocks = [];
const RADIUS = 0.8;
const TOTAL_LANES = 8;
const CENTER_Z = -10; // block spawn along parallel
const SPAWN_Y = 1; // where blocks spawn
const BLOCK_SPEED = 3;

let score = 0;
let saberBox = new THREE.Box3();

class Block {
  constructor(lane = 0, speed = BLOCK_SPEED) {
    this.lane = lane;
    this.speed = speed;
    this.mesh = null;
    this.hit = false;
    // hit detection
    this.boundingBox = new THREE.Box3();

    this.mesh = loader.load("/assets/block.glb", (gltf) => {
      this.mesh = gltf.scene;
      gltf.scene.scale.set(0.2, 0.2, 0.2);
      gltf.scene.rotateY(-Math.PI / 2);
      const angle = (lane / TOTAL_LANES) * Math.PI * 2;
      const x = Math.cos(angle) * RADIUS - 0.3;
      const y = Math.sin(angle) * RADIUS + SPAWN_Y;
      this.mesh.position.set(x, y, CENTER_Z);
      this.mesh.updateMatrixWorld(true);
      scene.add(this.mesh);

      this.boundingBox.setFromObject(this.mesh);
    });
  }

  update(dt) {
    if (!this.mesh) return;
    this.mesh.position.z += this.speed * dt;
    this.mesh.updateMatrixWorld(true);
    this.boundingBox.setFromObject(this.mesh);
    if (this.mesh.position.z > 10) {
      this.destroy();
    }
  }

  destroy() {
    scene.remove(this.mesh);
  }
}

// spawn helper
function spawnBlock(lane = 0, speed = BLOCK_SPEED) {
  const block = new Block(lane, speed);
  blocks.push(block);
  return block;
}

// continuously spawn blocks randomly in random intervals
function spawn() {
  const lane = Math.floor(Math.random() * TOTAL_LANES);
  const speed = Math.random() * (BLOCK_SPEED - 1) + 1;
  spawnBlock(lane, speed);
  endlessSpawnTimerId = setTimeout(() => {
    endlessSpawnTimerId = null;
    spawn();
  }, Math.random() * 1000);
}

function scheduleRhythmFromElapsed(elapsedMs) {
  const { audio, onsetDelays } = rhythmTrack;
  const firstDelay = onsetDelays.length > 0 ? Math.min(...onsetDelays) : 0;
  for (let i = 0; i < onsetDelays.length; i++) {
    const rem = onsetDelays[i] * 1000 - elapsedMs;
    if (rem > 0) {
      const id = setTimeout(() => {
        spawnBlock(Math.floor(Math.random() * TOTAL_LANES));
      }, rem);
      rhythmSpawnTimerIds.push(id);
    }
  }
  const playRem = firstDelay * 1000 - elapsedMs;
  const startAudio = () => {
    audio.play().catch(() => {
      statusEl.textContent =
        "Could not play audio — click the game view and try again.";
    });
    if (!rhythmEndedHooked) {
      rhythmEndedHooked = true;
      audio.addEventListener(
        "ended",
        () => {
          page("gameFinish");
          const scoreEl = document.getElementById("score");
          if (scoreEl) scoreEl.textContent = String(score);
          gamePaused = true;
          gameplayStartedAt = 0;
        },
        { once: true },
      );
    }
  };
  if (playRem > 0) {
    rhythmSpawnTimerIds.push(setTimeout(startAudio, playRem));
  } else {
    startAudio();
  }
}

function beginRhythmOrEndlessGameplay() {
  firebaseLobbyPageEnabled = false;
  page("gameStart");
  gameplayStartedAt = performance.now();
  rhythmEndedHooked = false;
  if (rhythmTrack) {
    scheduleRhythmFromElapsed(0);
  } else {
    spawn();
  }
}

function startGame() {
  gamePaused = false;
  const container = document.getElementById("gameContainer");
  container.style.display = "block";
  document.getElementById("joinContainer").style.display = "none";
  document.getElementById("gameTitle").style.display = "none";

  document.getElementById("startGameButton").style.display = "none";
  container.innerHTML = "<p>3</p>";
  setTimeout(() => {
    container.innerHTML = "<p>2</p>";
    setTimeout(() => {
      container.innerHTML = "<p>1</p>";
      setTimeout(() => {
        container.innerHTML = "<p>Go!</p>";
        beginRhythmOrEndlessGameplay();
      }, 1000);
    }, 1000);
  }, 1000);
}

document.getElementById("startGameButton").addEventListener("click", startGame);

function hitBlock(block) {
  block.hit = true;
  block.destroy();
  const i = blocks.indexOf(block);
  if (i > -1) blocks.splice(i, 1);
  score++;
}

function updateCollisions() {
  if (!saberMesh) return;
  saberMesh.updateMatrixWorld(true);
  saberBox.setFromObject(saberMesh);

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block.mesh) continue;
    if (saberBox.intersectsBox(block.boundingBox)) {
      hitBlock(block);
    }
  }
}

function updateBlocks(delta) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    blocks[i].update(delta);
  }
}

// get music file input
const musicForm = document.querySelector("#musicForm");
musicForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fileInput = document.querySelector("#musicFile");
  const file = fileInput.files[0];
  document.getElementById("analyzeButton").innerHTML = "Analyzing...";
  if (file) {
    const essentia = new Essentia(EssentiaWASM);
    const audioContext = new AudioContext();

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0); // Use first channel for mono
    const signal = essentia.arrayToVector(channelData);

    // get them rhythms
    // use this to find all algorithm that come with the package: console.log(essentia.algorithmNames);
    const results = essentia.SuperFluxExtractor(
      signal,
      10, // combine (ms) — merge close onsets
      2048, // frameSize
      256, // hopSize
      24, // ratioThreshold (increase from 16 → less sensitive)
      audioBuffer.sampleRate,
      0.05,
    );
    // results.onsetRate gives onsets per second
    // results.onsets gives the array of timestamps
    const onsetTimes = essentia.vectorToArray(results.onsets);
    // console.log("Onsets:", onsetTimes);

    // ------- block spawning logic - music correct -------
    document.getElementById("analyzeButton").innerHTML = "Finished analyzing";
    // Calculate delay so blocks reach the player in sync with audio
    const blockTravelTime =
      Math.abs(CENTER_Z - controls.getObject().position.z) / BLOCK_SPEED; // or 1 second
    // console.log("Block travel time:", blockTravelTime);
    const onsetDelays = onsetTimes.map((t) => Math.max(0, t - blockTravelTime));

    const audio = new Audio(URL.createObjectURL(file));
    audio.volume = 0.2;
    rhythmTrack = { audio, onsetDelays };
  } else {
    document.getElementById("analyzeButton").innerHTML = "Analyze & use track";
  }
});

function loop() {
  const now = performance.now() / 1000;
  const delta = now - lastTime;
  lastTime = now;

  updateRacketFromPhone();

  updateCamera(delta);
  // if (!gamePaused) {
  //   // camera
  // }

  // blocks
  if (!gamePaused) {
    updateBlocks(delta);
    updateCollisions();
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

loop();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
