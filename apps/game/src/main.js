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
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { rtdb } from "./firebase";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import { DestructibleMesh } from "@dgreenheck/three-pinata";

let gamePaused = true;
let blocksHit = 0;
let blocksDestroyed = 0;
let streak = 0;
let previousStreak = 0;
let highestStreak = 0;

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

// MARK: pages
function pageHelper(
  showHud,
  showHelpModal,
  showPauseModal,
  showGameFinishModal,
  showJoinContainer,
  showGameContainer,
  showMusicForm,
  showGameTitle,
  showStreak,
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
  const streakEl = document.getElementById("streak");
  if (streakEl) streakEl.style.display = showStreak ? "block" : "none";
}

function rankFromFillPct(fillPct) {
  const x = Math.min(100, Math.max(0, fillPct));
  if (x == 100) return "SSS";
  if (x > 90) return "SS";
  if (x > 80) return "S";
  if (x > 65) return "A";
  if (x > 50) return "B";
  if (x > 35) return "C";
  if (x > 20) return "D";
  return "E";
}

function playRankSlam(rankEl) {
  if (!rankEl) return;
  rankEl.getAnimations?.().forEach((a) => a.cancel());
  rankEl.animate(
    [
      { transform: "scale(1)", offset: 0 },
      { transform: "scale(1.65)", offset: 0.38 },
      { transform: "scale(1)", offset: 1 },
    ],
    {
      duration: 3000,
      easing: "cubic-bezier(0.28, 1.35, 0.45, 1)",
    },
  );
}

function page(mode) {
  pageMode = mode;
  if (pageMode === "initialState") {
    pageHelper(true, false, false, false, true, false, true, true, false);
  } else if (pageMode === "gameStart" || pageMode === "gamestart") {
    // Fullscreen-style play: hide entire HUD overlay
    pageHelper(false, false, false, false, false, false, false, false, true);
  } else if (pageMode === "gameAlmostStart") {
    // when the game is almost ready to start
    pageHelper(true, false, false, false, false, true, true, false, false);
  } else if (pageMode === "pause" || pageMode === "pauseModal") {
    pageHelper(true, false, true, false, false, false, false, false, true);
  } else if (pageMode === "gameFinish") {
    stopGameplayTimers();
    if (rhythmTrack?.audio) rhythmTrack.audio.pause();
    clearAllBlocks();
    pageHelper(true, false, false, true, false, false, false, false, false);
    const scoreEl = document.getElementById("score");
    if (scoreEl) scoreEl.textContent = String(score);
    const highestStreakEl = document.getElementById("highestStreak");
    if (highestStreakEl) {
      highestStreakEl.textContent = String(
        Math.max(highestStreak, streak),
      );
    }
    const track = document.getElementById("scoreAnimation");
    const bar = document.getElementById("scoreAnimationBar");
    const accEl = document.getElementById("scoreAccuracy");
    const pct =
      blocksHit + blocksDestroyed > 0
        ? Math.min(
            100,
            Math.max(0, (blocksHit / (blocksHit + blocksDestroyed)) * 100),
          )
        : 0;
    if (accEl) {
      accEl.textContent =
        blocksHit + blocksDestroyed > 0
          ? `${blocksHit} / ${blocksHit + blocksDestroyed} blocks — ${Math.round(pct)}%`
          : "No blocks this round";
    }
    if (bar && track) {
      const tier = pct > 75 ? 4 : pct > 50 ? 3 : pct > 25 ? 2 : 1;
      bar.dataset.scoreTier = String(tier);
      bar.getAnimations?.().forEach((a) => a.cancel());
      bar.style.width = "0%";

      const rankEl = document.getElementById("rank");
      let lastRank = rankFromFillPct(0);
      if (rankEl) {
        rankEl.textContent = lastRank;
      }

      requestAnimationFrame(() => {
        const anim = bar.animate([{ width: "0%" }, { width: `${pct}%` }], {
          duration: 1600,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        });

        const syncRankToBarWidth = () => {
          const tw = track.offsetWidth;
          const fillPct =
            tw > 0 ? Math.min(100, (bar.offsetWidth / tw) * 100) : 0;
          const r = rankFromFillPct(fillPct);
          if (rankEl && r !== lastRank) {
            lastRank = r;
            rankEl.textContent = r;
            playRankSlam(rankEl);
          }
        };

        const loop = () => {
          syncRankToBarWidth();
          if (anim.playState !== "finished") {
            requestAnimationFrame(loop);
          } else {
            syncRankToBarWidth();
          }
        };
        requestAnimationFrame(loop);
      });
    }
  } else if (pageMode === "helpModal") {
    pageHelper(true, true, false, false, false, false, false, false, true);
  }
}

document.getElementById("restartGameButton")?.addEventListener("click", () => {
  stopGameplayTimers();
  if (rhythmTrack?.audio) rhythmTrack.audio.pause();
  clearAllBlocks();
  page("initialState");
  blocksHit = 0;
  blocksDestroyed = 0;
  score = 0;
  streak = 0;
  previousStreak = 0;
  highestStreak = 0;
  gamePaused = true;
  gameplayStartedAt = 0;
  rhythmEndedHooked = false;
});

document.getElementById("finishGameButton")?.addEventListener("click", () => {
  page("gameFinish");
  gamePaused = true;
  gameplayStartedAt = 0;
});

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
scene.background = new THREE.Color("#0a0a0a");

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

// MARK: environment
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
  saberMesh.position.set(SABER_HOME.x, SABER_HOME.y, SABER_HOME.z);
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

// MARK: block spawning
const blocks = [];

function clearAllBlocks() {
  for (const block of blocks) {
    if (block.mesh) scene.remove(block.mesh);
    block.mesh = null;
  }
  blocks.length = 0;
}

function stopGameplayTimers() {
  for (const id of rhythmSpawnTimerIds) clearTimeout(id);
  rhythmSpawnTimerIds.length = 0;
  if (endlessSpawnTimerId) {
    clearTimeout(endlessSpawnTimerId);
    endlessSpawnTimerId = null;
  }
}

const RADIUS = 0.8;
const TOTAL_LANES = 8;
const CENTER_Z = -10; // block spawn along parallel
const SPAWN_Y = 1; // where blocks spawn
const BLOCK_SPEED = 3;
/** Split debris is removed after this; it must not trigger miss/streak logic. */
const FRAGMENT_LIFETIME_MS = 1000;

let score = 0;
let saberBox = new THREE.Box3();

const _worldUp = new THREE.Vector3(0, 1, 0);
const _bladeWorld = new THREE.Vector3();
const _sliceN = new THREE.Vector3();
const _toBlock = new THREE.Vector3();
const _pieceCenter = new THREE.Vector3();
const _tumbleAxis = new THREE.Vector3();
const _tmpBox = new THREE.Box3();

/** Shared futuristic shell + cut-face materials so slices read as solid, not hollow shells. */
const blockOuterMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x3ad4ff,
  emissive: 0x120a40,
  emissiveIntensity: 0.55,
  metalness: 0.35,
  roughness: 0.28,
  clearcoat: 1,
  clearcoatRoughness: 0.15,
  iridescence: 0.85,
  iridescenceIOR: 1.5,
  iridescenceThicknessRange: [80, 280],
});
const blockInnerMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x6ae8ff,
  emissive: 0x1a5088,
  emissiveIntensity: 0.75,
  metalness: 0.5,
  roughness: 0.35,
  clearcoat: 0.9,
  clearcoatRoughness: 0.2,
});

function computeSlicePlaneWorldNormal(saberMesh, blockWorldCenter) {
  // Saber rig: blade runs along local +X after GLTF setup (see saber load).
  _bladeWorld.set(1, 0, 0).applyQuaternion(saberMesh.quaternion).normalize();
  _toBlock.subVectors(blockWorldCenter, saberMesh.position);
  _sliceN.crossVectors(_bladeWorld, _toBlock);
  if (_sliceN.lengthSq() < 1e-5) {
    _sliceN.crossVectors(_bladeWorld, _worldUp);
  }
  if (_sliceN.lengthSq() < 1e-5) {
    _sliceN.set(0, 1, 0);
  }
  return _sliceN.normalize();
}

// MARK: class
class Block {
  constructor(lane = 0, speed = BLOCK_SPEED, opts = {}) {
    this.lane = lane;
    this.speed = speed;
    this.hit = false;
    this.boundingBox = new THREE.Box3();
    this.fragmentMotion = false;
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.angularVelocity = new THREE.Vector3(0, 0, 0);

    const size = 0.5; // box size

    // mesh
    if (opts.prefabMesh) {
      this.mesh = opts.prefabMesh;
      this.mesh.updateMatrixWorld(true);
      this.boundingBox.setFromObject(this.mesh);
      return;
    }

    const geometry = new RoundedBoxGeometry(1, 1, 1, 6, 0.14);
    this.mesh = new DestructibleMesh(
      geometry,
      blockOuterMaterial,
      blockInnerMaterial,
    );

    const angle = (lane / TOTAL_LANES) * Math.PI * 2;
    const x = Math.cos(angle) * RADIUS - 0.3;
    const y = Math.sin(angle) * RADIUS + SPAWN_Y;
    
    this.mesh.scale.set(size, size, size);
    this.mesh.position.set(x, y, CENTER_Z);
    this.mesh.updateMatrixWorld(true);

    scene.add(this.mesh);
    this.boundingBox.setFromObject(this.mesh);
  }

  /**
   * @param {import("@dgreenheck/three-pinata").DestructibleMesh} mesh
   * @param {THREE.Vector3} linearVel
   * @param {THREE.Vector3} angularVel
   */
  static fromFragment(mesh, linearVel, angularVel) {
    const b = new Block(0, BLOCK_SPEED, { prefabMesh: mesh });
    b.fragmentMotion = true;
    b.fragmentSpawnAt = performance.now();
    b.velocity.copy(linearVel);
    b.angularVelocity.copy(angularVel);
    return b;
  }

  /** Remove split debris without counting as a missed block. */
  disposeFragment() {
    if (!this.mesh) return;
    scene.remove(this.mesh);
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    this.mesh = null;
    const i = blocks.indexOf(this);
    if (i > -1) blocks.splice(i, 1);
  }

  update(dt) {
    if (!this.mesh) return;

    if (this.fragmentMotion) {
      if (performance.now() - this.fragmentSpawnAt >= FRAGMENT_LIFETIME_MS) {
        this.disposeFragment();
        return;
      }
      this.mesh.position.addScaledVector(this.velocity, dt);
      const wx = this.angularVelocity.x * dt;
      const wy = this.angularVelocity.y * dt;
      const wz = this.angularVelocity.z * dt;
      if (Math.abs(wx) > 1e-8) this.mesh.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), wx);
      if (Math.abs(wy) > 1e-8) this.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), wy);
      if (Math.abs(wz) > 1e-8) this.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), wz);
      this.velocity.multiplyScalar(0.997);
    } else {
      this.mesh.position.z += this.speed * dt;
    }

    this.mesh.updateMatrixWorld(true);
    this.boundingBox.setFromObject(this.mesh);
    if (!this.fragmentMotion && this.mesh.position.z > 1) {
      streak = 0;
      blocksDestroyed++;
      scene.remove(this.mesh);
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      this.mesh = null;
      const i = blocks.indexOf(this);
      if (i > -1) blocks.splice(i, 1);
    }
  }

  destroy() {
    if (!this.mesh) return;
    scene.remove(this.mesh);
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    this.mesh = null;
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
  streak = 0;
  previousStreak = 0;
  highestStreak = 0;
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

  // document.getElementById("startGameButton").style.display = "none";
  // reomved because gameContainer is hidden when game starts
  const styling =
    "color: #fff; font-size: 3.5rem; font-weight: 600; cursor: pointer; transition: color 0.15s ease;";
  container.innerHTML = `<p style="${styling}">3</p>`;
  setTimeout(() => {
    container.innerHTML = `<p style="${styling}">2</p>`;
    setTimeout(() => {
      container.innerHTML = `<p style="${styling}">1</p>`;
      setTimeout(() => {
        container.innerHTML = `<p style="${styling}">Go!</p>`;
        beginRhythmOrEndlessGameplay();
      }, 1000);
    }, 1000);
  }, 1000);
}

document.getElementById("startGameButton").addEventListener("click", startGame);

// MARK: hit block
function hitBlock(block) {
  if (!saberMesh || !block.mesh) return;
  if (block.hit) return;

  block.hit = true;

  blocksHit++;
  score++;
  streak++;
  highestStreak = Math.max(highestStreak, streak);

  const worldOrigin = new THREE.Vector3();
  block.mesh.getWorldPosition(worldOrigin);
  const worldNormal = computeSlicePlaneWorldNormal(saberMesh, worldOrigin);

  const pieces = block.mesh.sliceWorld(worldNormal, worldOrigin);

  const idx = blocks.indexOf(block);
  if (idx > -1) blocks.splice(idx, 1);
  block.destroy();

  if (!pieces || pieces.length === 0) return;

  const sep = 3.4;

  pieces.forEach((piece, index) => {
    piece.updateMatrixWorld(true);
    _tmpBox.setFromObject(piece);
    _tmpBox.getCenter(_pieceCenter);

    const side = Math.sign(_pieceCenter.clone().sub(worldOrigin).dot(worldNormal));
    const sign = side === 0 ? (index === 0 ? 1 : -1) : side;

    const linearVel = worldNormal.clone().multiplyScalar(sign * sep);
    linearVel.y += 0.42;
    if (block.fragmentMotion) {
      linearVel.add(block.velocity);
    } else {
      linearVel.z += block.speed;
    }

    _tumbleAxis.crossVectors(worldNormal, _worldUp);
    if (_tumbleAxis.lengthSq() < 1e-6) {
      _tumbleAxis.crossVectors(worldNormal, _bladeWorld);
    }
    if (_tumbleAxis.lengthSq() < 1e-6) {
      _tumbleAxis.set(1, 0, 0);
    }
    _tumbleAxis.normalize();

    const spin = sign * 2.6;
    const angularVel = _tumbleAxis.clone().multiplyScalar(spin);

    scene.add(piece);
    blocks.push(Block.fromFragment(piece, linearVel, angularVel));
  });
}

function updateCollisions() {
  if (!saberMesh) return;
  saberMesh.updateMatrixWorld(true);

  // better hitbox
  let tightBox = new THREE.Box3();

  saberMesh.traverse((child) => {
    if (child.isMesh && child.geometry) {
      child.geometry.computeBoundingBox();
      const childBox = new THREE.Box3().copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
      tightBox.union(childBox);
    }
  });

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block.mesh) continue;
    if (block.hit) continue;
    if (block.fragmentMotion) continue;
    if (tightBox.intersectsBox(block.boundingBox)) {
      hitBlock(block);

      // play sound
      if (!window.hitSoundPool) {
        window.hitSoundPool = Array.from({ length: 5 }, () => new Audio("assets/chop.mp3"));
        window.hitSoundPoolIdx = 0;
      }
      const pool = window.hitSoundPool;
      const idx = window.hitSoundPoolIdx;
      pool[idx].currentTime = 0;
      pool[idx].play();
      window.hitSoundPoolIdx = (idx + 1) % pool.length;
    }
  }
}

function updateBlocks(delta) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    blocks[i].update(delta);
  }
}

function updateStreak() {
  const streakEl = document.getElementById("streakNumber");
  if (!streakEl) return;
  streakEl.innerHTML = String(streak);

  const clamped = Math.max(0, Math.min(200, streak));
  // 2. Map 0-200 to a 0-1 ratio
  const ratio = clamped / 200;

  // 3. Calculate Hue: Violet (270) to Red (0)
  // (270 - 0) * ratio tells us how much to subtract from 270
  const hue = 270 - ratio * 270;

  // streak increase
  if (previousStreak < streak && streak > 0) {
    previousStreak = streak;
    streakEl.innerHTML = streak;

    // number animation
    // Monkeytype-style spark fly animation when streak increases
    requestAnimationFrame(() => {
      streakEl.getAnimations?.().forEach((a) => a.cancel());
      // Make the effect scale and shake much more intense
      const minScale = 1.18; // Up from 1.15
      const maxScale = 2.8; // Was 2.25, now bigger on streaks
      const maxStreak = 200;
      const extraScale =
        Math.min(streak / maxStreak, 1) * (maxScale - minScale);
      const scale = minScale + extraScale;

      // Boosted rotation shake values
      const baseRotate = 21; // Up from 10 deg
      const maxRotate = 65; // Up from 34 deg
      const rotate =
        baseRotate + (maxRotate - baseRotate) * Math.min(streak / maxStreak, 1);
      const rotation = (Math.random() - 0.5) * 2 * rotate;

      // Add a rapid "shudder" (quick jitter) while at max scale/rotate
      streakEl.animate(
        [
          {
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            color: `hsl(${hue}, 100%, 80%)`,
            filter: "drop-shadow(0 3px 20px hsl(200,90%,78%))",
            offset: 0,
          },
          {
            // Quick jitter halfway
            transform: `scale(${scale * 1.15}) rotate(${rotation + (Math.random() - 0.5) * 36}deg)`,
            color: `hsl(${hue}, 98%, 64%)`,
            filter: "drop-shadow(0 4px 32px hsl(210,85%,72%))",
            offset: 0.21,
          },
          {
            // Snap to opposite jitter
            transform: `scale(${scale * 1.19}) rotate(${-rotation * 1.1 + (Math.random() - 0.5) * 28}deg)`,
            color: `hsl(${hue}, 97%, 62%)`,
            offset: 0.42,
            filter: "drop-shadow(0 5px 28px hsl(210,85%,60%))",
          },
          {
            transform: `scale(1) rotate(0deg)`,
            color: `hsl(${hue}, 100%, 50%)`,
            filter: "none",
            offset: 1,
          },
        ],
        {
          duration: 940 + Math.min(streak, 50) * 7, // longer for more anticipation
          easing: "cubic-bezier(.49,1.8,.28,1.03)", // more snap
          fill: "forwards",
        },
      );

      // Spark fly animation (unchanged)
      const streakRect = streakEl.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();

      for (let i = 0; i < 18; i++) {
        const spark = document.createElement("div");
        spark.className = "streak-spark";
        // Position at center of streakEl
        spark.style.position = "fixed";
        spark.style.pointerEvents = "none";
        spark.style.left = `${streakRect.left + streakRect.width / 2 - bodyRect.left}px`;
        spark.style.top = `${streakRect.top + streakRect.height / 2 - bodyRect.top}px`;
        spark.style.width = "6px";
        spark.style.height = "2px";
        spark.style.background = `hsl(${hue}, 100%, 65%)`;
        spark.style.borderRadius = "2px";
        spark.style.boxShadow = "0 0 8px hsl(210 100% 80% / 0.6)";
        spark.style.opacity = ".86";
        spark.style.zIndex = "9999";
        spark.style.transform = `translate(-50%, -50%) rotate(${Math.random() * 360}deg) scale(1.1)`;
        spark.style.transition = "opacity 0.33s linear";

        // random direction and speed
        const angle = Math.PI * 2 * (i / 18) + (Math.random() - 0.5) * 0.22;
        const distance = 36 + Math.random() * 32 + (scale - 1.18) * 23; // further on high streak

        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance * (0.6 + Math.random() * 0.6);

        spark.animate(
          [
            {
              transform: `translate(-50%, -50%) rotate(${angle}rad) scale(1.1)`,
              opacity: 0.85,
            },
            {
              transform: `translate(${x - 3}px, ${y + 3}px) rotate(${angle}rad) scale(0.7)`,
              opacity: 0,
            },
          ],
          {
            duration: 540 + Math.random() * 380 + (scale - 1.18) * 120, // slightly longer and wider
            easing: "cubic-bezier(.43,1.52,.61,1)",
            fill: "forwards",
          },
        );

        setTimeout(() => {
          spark.style.opacity = "0";
          setTimeout(() => spark.remove(), 300);
        }, 340);
        document.body.appendChild(spark);
      }
    });
    setTimeout(() => {
      streakEl.style.color = `hsl(${hue}, 100%, 50%)`;
      streakEl.style.transform = "scale(1) rotate(0deg)";
      streakEl.style.filter = "none";
    }, 1100);
  } else {
    // streak reset
    previousStreak = streak;
    streakEl.innerHTML = streak;
    streakEl.style.color = `hsl(${hue}, 100%, 50%)`;
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
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      const channelData = audioBuffer.getChannelData(0); // Use first channel for mono
      const signal = essentia.arrayToVector(channelData);

      const results = essentia.SuperFluxExtractor(
        signal,
        10, // combine (ms) — merge close onsets
        2048, // frameSize
        256, // hopSize
        24, // ratioThreshold (increase from 16 → less sensitive)
        audioBuffer.sampleRate,
        0.05,
      );
      const onsetTimes = essentia.vectorToArray(results.onsets);

      document.getElementById("analyzeButton").innerHTML = "Finished analyzing";
      const blockTravelTime =
        Math.abs(CENTER_Z - controls.getObject().position.z) / BLOCK_SPEED;
      const onsetDelays = onsetTimes.map((t) =>
        Math.max(0, t - blockTravelTime),
      );

      if (rhythmTrack?.audio) {
        const prev = rhythmTrack.audio.src;
        rhythmTrack.audio.pause();
        if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      }
      const audio = new Audio(URL.createObjectURL(file));
      audio.volume = 0.2;
      rhythmTrack = { audio, onsetDelays };
    } catch {
      document.getElementById("analyzeButton").innerHTML =
        "Analyze & use track";
    } finally {
      await audioContext.close();
    }
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
    updateStreak();
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
