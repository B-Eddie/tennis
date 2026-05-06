# Phone Tennis

Non-VR tennis game where the desktop renders the scene and the phone is the racket controller. Sensor data is relayed through Firebase Realtime Database, so it works on Vercel without a backend server.

## Layout

- `apps/game/` — Vite app, two pages:
  - `/` — Three.js + Cannon.js game scene (desktop)
  - `/phone.html` — phone controller (DeviceOrientation + DeviceMotion)
- `docs/firebase-setup.md` — Firebase RTDB setup

## Prerequisites

- Node.js 20+
- Firebase project with Realtime Database enabled (see `docs/firebase-setup.md`)

## Install

```bash
npm install
```

## Run locally

```bash
npm run dev
```

- Game: `https://localhost:5173/`
- Phone: `https://localhost:5173/phone.html` (the QR code generates a session-specific URL)

## Deploy

- Single Vercel project pointing at `apps/game`.
- Set `VITE_FIREBASE_*` env vars in Vercel.
- The QR code automatically points to `<your-domain>/phone.html?session=...`.

## Notes

- iOS requires user interaction before granting motion/orientation permissions.
- The local dev server uses a self-signed certificate; accept the browser warning when first opening on phone.
