# Firebase Setup Guide

Both apps relay sensor data through **Firebase Realtime Database** (RTDB), so no WebSocket server is needed and everything works on Vercel.

## 1) Enable Realtime Database

1. Go to [Firebase Console](https://console.firebase.google.com/) -> your project (`tennis-33b6a`)
2. In the left nav, open **Build > Realtime Database**
3. Click **Create Database**
4. Choose a location (US, Europe, etc)
5. Start in **test mode** for development

## 2) Copy your databaseURL

In **Realtime Database**, you'll see a URL near the top, for example:

- US default region: `https://tennis-33b6a-default-rtdb.firebaseio.com`
- Other regions: `https://tennis-33b6a-default-rtdb.<region>.firebasedatabase.app`

Set this in **both** envs:

- `apps/game/.env` -> `VITE_FIREBASE_DATABASE_URL=...`
- `apps/phone/.env` -> `VITE_FIREBASE_DATABASE_URL=...`

## 3) Realtime Database rules (dev only)

In the **Rules** tab of Realtime Database:

```json
{
  "rules": {
    "sessions": {
      "$sessionId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

This is permissive enough for testing. Lock it down with Firebase Auth before going public.

## 4) Data shape

Used at `sessions/{sessionId}`:

```json
{
  "game":       { "online": true, "createdAt": <ts> },
  "phone":      { "online": true, "connectedAt": <ts>, "device": "..." },
  "controller": { "orientation": { "alpha": 0, "beta": 0, "gamma": 0 },
                   "motion":      { "x": 0, "y": 0, "z": 0 } }
}
```

## 5) Deploy notes for Vercel

- One Vercel project, root = `apps/game`. Phone is served from `/phone.html` on the same domain.
- In Vercel project settings, set all `VITE_FIREBASE_*` env vars to match your `.env`.
- After deploy, the QR code automatically points to `https://<your-app>.vercel.app/phone.html?session=...`.

## 6) Verify

1. Run locally: `npm run dev`
2. Open game app -> see QR code
3. Scan QR on phone -> grant motion permissions
4. Open Firebase Console -> Realtime Database -> watch `sessions/<id>/controller` update in real time
