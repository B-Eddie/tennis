<p align="center">
  <img src="apps/game/public/assets/favicon.png" alt="PhoneSaber Favicon" height="180" />
</p>

# PhoneSaber

Non-VR rhythm saber game where the desktop displays the game and the phone is the controller. Try it at:

    $ https://tennis-game-kappa.vercel.app/

## The problem
Ever looked at VR games and be like "yo that looks so fun, i wanna play" and then search on google for "vr kit cost", then go like "what i aint paying $400-$800 (not even including the game) just to play a game"? Well thats me lol.
I tried looking for some non-vr versions of games, but only found those apps that use your camera and track your hand movements for games (eg. Active Arcade). However, I feel like these games don't capture the full experience that VR does and has a lot of accuracy issues.

## Solution
PhoneSaber uses your phone's sensors (gyro) to accurately move the saber in the game based on your motions.

## The future
Since phones don't have sensors that detect translational motion, this app only allows users to rotate the saber. So, combining the rotational movement from the sensors with camera-based tracking that detects motion in space will make the game more accurate and fun to play.

## Tech Stack
- **Three.js** - 3D scene, saber, blocks, slicing
- **Firebase** - realtime phone-to-game connection
- **Vite** - development and build server

## Features
- Phone pairing with game browser through QR code
- 3D desktop scene
- Music uploading & tailored rhythm
- Cool block slicing
- Streak counter that gets progressively crazier

## Challenges
- Phone sensor only gives rotation and not translation
- Apple blocking features - I wanted to add a vibration every time a block was chopped, but Apple said nuh uh
- Slicing - slicing the mesh in too had too many things to consider (double hitting, how to actually split the block, physics of how the blocks move after splitting)