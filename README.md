# Orbit Cut

Keep the subject in view when a 360° film cuts to its next shot.

Two matching lenses show the last frame before a cut and the video after it. Pinch the orange wheel to rotate the next shot, replay the cut from the same viewpoint, and export the changed pixels as an MP4.

**An early, single-cut workbench.** Open a local monoscopic 2:1 MP4, set the cut time, and work seated. The built-in twelve-second practice film is synthetic and intentionally has a 55° heading jump. Try **Waterfall practice** for an attributed real-camera clip with an intentionally added cut. Video files are processed in the browser. [Media sources and modifications](public/media/SOURCES.md).

## Editing

- Point and pinch the wheel, then turn your hand. Controllers also work; the turn buttons offer 5° steps.
- **Replay cut** starts two seconds before the cut. The left lens remains your reference.
- **Reset** removes the rotation. **Export MP4** renders in real time, with the soundtrack.
- The save link stays available in the browser after leaving immersion.

Preview export uses the browser's native recorder, up to 30 fps. It prefers H.264/AAC when available; Chromium's tested fallback is an MP4 containing VP9/Opus. The exact format is shown after export. Frame-exact delivery, spherical metadata, multiple cuts, and physical Quest performance are the next quality milestones.

## Run and verify

```sh
npm ci
npx playwright install --with-deps chromium
npm run typecheck
IWSDK_GPU=swiftshader python3 scripts/xr-smoke.py
ORBIT_MEDIA_OUTPUT="$PWD/temp/media" node scripts/media-smoke.mjs
npm run build
```

The media check needs FFmpeg. It imports two synthetic videos, rotates actual decoded frames, exports and reopens the MP4, measures the changed pixels, and checks the soundtrack. The XR check uses the SDK's controller and hand inputs rather than changing application state directly. GitHub Actions retains the resulting receipts and images, and publishes successful builds to Pages.

XR is an immersive session. [IWSDK's testing guide](https://iwsdk.dev/guides/02-testing-experience.html) describes it; [IWER](https://meta-quest.github.io/immersive-web-emulation-runtime) provides the browser emulator used by the checks. A controller's target ray points at controls; its grip pose is where an object is held. [IWSDK's interaction guide](https://iwsdk.dev/concepts/interaction/grabbing.html) covers those input paths. The app's entity-component system (ECS) keeps editing state inspectable through named components; see [IWSDK concepts](https://iwsdk.dev/concepts/).

[Earlier runtime foundation receipt](docs/runtime-proof.json) records the separate, unchanged starter-scene gate. Emulated interaction and physical headset measurements are tracked separately.

Built with Meta's MIT-licensed Immersive Web SDK.
