import * as THREE from "three";
import * as CANNON from "cannon-es";
import QRCode from "qrcode";

const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const SERVER_URL = `${wsProtocol}://${window.location.host}/socket`;
const statusEl = document.querySelector("#status");
const joinLinkEl = document.querySelector("#joinLink");
const joinQrEl = document.querySelector("#joinQr");

const sessionId = crypto.randomUUID();
const phoneBaseUrl = `${window.location.protocol}//${window.location.hostname}:5174`;
const joinLink = `${phoneBaseUrl}?session=${sessionId}`;
joinLinkEl.href = joinLink;
joinLinkEl.textContent = joinLink;

QRCode.toDataURL(joinLink, {
  width: 320,
  margin: 1
})
  .then((dataUrl) => {
    joinQrEl.src = dataUrl;
  })
  .catch(() => {
    statusEl.textContent = "Could not generate QR code. Use the link below.";
  });

const scene = new THREE.Scene();
scene.background = new THREE.Color("#171b26");

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 2.5, 5.5);
camera.lookAt(0, 1.2, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(3, 5, 2);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.45));

const floorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 24),
  new THREE.MeshStandardMaterial({ color: "#2f3b45" })
);
floorMesh.rotation.x = -Math.PI / 2;
scene.add(floorMesh);

const racketMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.9, 0.08),
  new THREE.MeshStandardMaterial({ color: "#4dd6ff" })
);
racketMesh.position.set(0, 1.2, 2);
scene.add(racketMesh);

const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 24, 24),
  new THREE.MeshStandardMaterial({ color: "#ffe45e" })
);
scene.add(ballMesh);

const world = new CANNON.World({
  gravity: new CANNON.Vec3(0, -9.82, 0)
});

const floorBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(floorBody);

const ballBody = new CANNON.Body({
  mass: 0.08,
  shape: new CANNON.Sphere(0.12),
  position: new CANNON.Vec3(0, 1.6, -3)
});
ballBody.linearDamping = 0.02;
world.addBody(ballBody);

let phoneState = {
  orientation: { alpha: 0, beta: 0, gamma: 0 },
  motion: { x: 0, y: 0, z: 0 }
};

let ws;
function connectSocket() {
  ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "register", role: "game", sessionId }));
    statusEl.textContent = "Connected to relay server. Waiting for phone...";
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "controller-state") {
      phoneState = data.payload;
      statusEl.textContent = "Phone connected. Move your device to swing.";
    }

    if (data.type === "system") {
      statusEl.textContent = data.hasPhone
        ? "Phone connected. Move your device to swing."
        : "Waiting for phone to connect via your special link...";
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Relay disconnected. Reconnecting...";
    setTimeout(connectSocket, 1000);
  };
}
connectSocket();

const fixedTimeStep = 1 / 60;
let lastTime = performance.now() / 1000;

function updateRacketFromPhone() {
  const { beta, gamma } = phoneState.orientation;
  const { x, y, z } = phoneState.motion;

  racketMesh.rotation.x = THREE.MathUtils.degToRad(beta * 0.6);
  racketMesh.rotation.z = THREE.MathUtils.degToRad(-gamma * 0.8);

  racketMesh.position.x = THREE.MathUtils.clamp(gamma * 0.015, -1.5, 1.5);
  racketMesh.position.y = THREE.MathUtils.clamp(1.2 + beta * 0.005, 0.7, 2.1);

  const swingPower = Math.sqrt(x * x + y * y + z * z);
  const distance = racketMesh.position.distanceTo(
    new THREE.Vector3(ballBody.position.x, ballBody.position.y, ballBody.position.z)
  );

  if (distance < 0.55 && swingPower > 11) {
    ballBody.velocity.set(
      racketMesh.position.x * 0.7,
      1.6 + swingPower * 0.05,
      -6 - swingPower * 0.18
    );
  }
}

function loop() {
  const now = performance.now() / 1000;
  const delta = now - lastTime;
  lastTime = now;

  updateRacketFromPhone();
  world.step(fixedTimeStep, delta, 4);

  if (ballBody.position.z < -12 || ballBody.position.y < -1) {
    ballBody.position.set(0, 1.6, -3);
    ballBody.velocity.set(0, 0, 0);
  }

  ballMesh.position.copy(ballBody.position);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

loop();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});