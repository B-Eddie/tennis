# Phone Tennis Base

Starter project for a non-VR tennis game where:

- `apps/game` is the Three.js + Cannon.js desktop game scene
- `apps/phone` is the phone controller using DeviceOrientation + DeviceMotion
- `server` is a WebSocket relay between phone and game
- Firebase Firestore is used for initial session persistence

## Prerequisites

- Node.js 20+
- A phone and desktop on the same local network (for real device testing)

## Install

```bash
npm install
```

## Run everything

```bash
npm run dev
```

Services:

- WebSocket relay: `ws://localhost:8080`
- Game app: `https://localhost:5173`
- Phone controller app: `https://localhost:5174`

HTTPS notes:

- Vite runs with a local self-signed cert in dev.
- On phone, open the HTTPS game link and accept/trust the browser warning page first.
- WebSocket traffic is exposed as secure `wss://.../socket` on each app and proxied to the local relay server.

## Firebase

See `docs/firebase-setup.md` for full setup instructions.

Quick start:

1. Copy `apps/phone/.env.example` to `apps/phone/.env`
2. Fill with your Firebase project config
3. Enable Firestore in Firebase Console

## Notes

- iOS requires user interaction before granting motion/orientation permissions.
- This is a base scaffold. Networking sync, hit detection tuning, match flow, and production security still need to be built.
