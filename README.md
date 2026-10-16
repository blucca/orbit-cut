# Orbit Cut

Keep the subject in view when a 360° film cuts to its next shot.

Two matching lenses show the corrected previous shot and the video after a cut. Pinch the orange wheel to rotate the next shot, review the whole film as a panorama, and export the changed pixels as an MP4.

**A seated, two-cut workbench.** Open a local monoscopic 2:1 MP4, choose up to two cut times, and keep each shot's correction. The built-in twelve-second synthetic exercise has cuts at 4 and 8 seconds, with source headings of 0°, +55°, and -35°. Try **Waterfall practice** for an attributed real-camera clip with an intentionally added cut. Video files are processed in the browser. [Media sources and modifications](public/media/SOURCES.md).

[Open the workbench](https://blucca.github.io/orbit-cut/) · [Two-cut interaction and media receipt](docs/two-cut-proof.json) · [Real-camera export measurements](docs/real-media-proof.json)

Have a Quest and eight minutes? [Try the editing task and tell us where it gets awkward.](docs/quest-playtest.md)

![Two independently aligned cuts, with the previous correction retained](docs/two-cut-workbench.png)

## Editing

- Point and pinch the wheel, then turn your hand. Controllers also work; the turn buttons offer 5° steps.
- Select **Cut 1** or **Cut 2** in the headset. Move its boundary in 0.1- or 1-second steps; **Add cut** creates a second boundary and inherits the preceding shot's direction.
- The left lens includes the preceding shot's correction. Editing Cut 2 keeps Cut 1 intact.
- **Replay cut** starts two seconds before the cut. The left lens remains your reference.
- **Review 360** surrounds you with the film. **Original** and **Corrected** share the same viewing direction; pause to compare a fixed frame, or replay the whole film. **Back to edit** returns to the selected cut.
- **Reset** removes only the selected shot's rotation. **Export MP4** renders all corrected shots in real time, with the soundtrack.
- The save link stays available in the browser after leaving immersion.

![Corrected panorama reviewed from the same viewing direction](docs/two-cut-panorama.png)

Review export uses the browser's native recorder, up to 30 fps. It prefers H.264/AAC when available; Chromium's tested fallback is an MP4 containing VP9/Opus. The exact format is shown after export. Frame-exact delivery, spherical metadata, and physical Quest performance are the next quality milestones.

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
