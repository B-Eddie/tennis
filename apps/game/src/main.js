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

const statusEl = document.querySelector("#status");
const joinLinkEl = document.querySelector("#joinLink");
const joinQrEl = document.querySelector("#joinQr");

const sessionId = crypto.randomUUID().slice(0, 8);
const phoneBaseUrl = `${window.location.origin}/phone.html`;
const joinLink = `${phoneBaseUrl}?session=${sessionId}`;
joinLinkEl.href = joinLink;
joinLinkEl.textContent = joinLink;

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
const velocity = new THREE.Vector3();
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

// const floorMesh = new THREE.Mesh(
//   new THREE.PlaneGeometry(14, 24),
//   new THREE.MeshStandardMaterial({ color: "#336699" }),
// );
// floorMesh.rotation.x = -Math.PI / 2;
// scene.add(floorMesh);

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
let lastSampleTs = 0;

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
  statusEl.textContent =
    "Phone connected. Press C to recalibrate neutral pose.";
});

// recallibrate
window.addEventListener("keydown", (event) => {
  if (event.key === "c" || event.key === "C") {
    calibrationInverse = null;
    // transientVelocity.set(0, 0, 0);
    // transientOffset.set(0, 0, 0);
  }
});

const fixedTimeStep = 1 / 60;
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

let lastBlockSpawn = 0;
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

function spawner(now) {
  if (now - lastBlockSpawn > 1) {
    const lane = Math.floor(Math.random() * TOTAL_LANES);
    spawnBlock(lane);
    lastBlockSpawn = now;
  }
}

// hit detection
const HIT_WINDOW = 0.5; // hit tolerance

function hitBlock(block) {
  block.hit = true;
  block.destroy();
  const i = blocks.indexOf(block);
  if (i > -1) blocks.splice(i, 1);
  score++;

  console.log("Block hit! Score:", score);
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

function loop() {
  const now = performance.now() / 1000;
  const delta = now - lastTime;
  lastTime = now;

  updateRacketFromPhone();

  // camera
  updateCamera(delta);

  // blocks
  spawner(now);
  updateBlocks(delta);
  updateCollisions();

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

loop();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
