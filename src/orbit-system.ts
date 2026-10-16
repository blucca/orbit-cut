import {
  CanvasTexture, createSystem, Entity, Euler, Grabbed, GrabSystem, Mesh,
  ShaderMaterial, SRGBColorSpace, Texture, UIKit, UIKitMLAsset,
  Vector3, VideoTexture, VisibilityState,
} from '@iwsdk/core';
import { OrbitCutState, WorkbenchPart, YawRing } from './orbit-components.js';
import { MediaSession } from './media.js';

// Both windows use the same 70-degree lens and fixed world-facing sight.
function projection(texture: Texture): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { frame: { value: texture }, yaw: { value: 0 } },
    vertexShader: `varying vec2 imageUv;
      void main() { imageUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D frame; uniform float yaw; varying vec2 imageUv;
      void main() {
        vec3 ray = normalize(vec3((imageUv.x - 0.5) * 1.4004, (imageUv.y - 0.5) * 0.986, -1.0));
        vec2 sphereUv = vec2(fract(0.5 + atan(ray.x, -ray.z) / 6.2831853 - yaw / 360.0),
          0.5 + asin(ray.y) / 3.14159265);
        gl_FragColor = texture2D(frame, sphereUv);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
}

export class OrbitSystem extends createSystem({
  parts: { required: [WorkbenchPart] },
  held: { required: [YawRing, Grabbed] },
}) {
  private media = new MediaSession();
  private state!: Entity;
  private ring!: Entity;
  private panel!: UIKitMLAsset;
  private preview!: ShaderMaterial;
  private reference!: ShaderMaterial;
  private videoTexture!: VideoTexture;
  private referenceTexture!: CanvasTexture;
  private wheelAngles = new Euler(0, 0, 0, 'YXZ');
  private anchor = new Vector3();
  private head = new Vector3();
  private benchOffsetY = 0;
  private recenterFrames = 0;
  private knownOffset = true;
  private busy = false;
  private lastPreviewYaw = NaN;
  private downloadUrl = '';

  init(): void {
    this.state = this.world.requireSceneEntity('orbit-cut-state');
    this.ring = this.world.requireSceneEntity('orbit-yaw-ring');
    this.anchor.copy(this.ring.object3D!.position);
    this.panel = this.world.requireSceneObject<UIKitMLAsset>('workbench-panel');
    const grabbing = this.world.getSystem(GrabSystem);
    if (grabbing) grabbing.config.useHandPinchForGrab.value = true;
    const frame = this.world.requireSceneObject('optical-frame');
    this.videoTexture = new VideoTexture(this.media.video);
    this.videoTexture.colorSpace = SRGBColorSpace;
    this.referenceTexture = new CanvasTexture(document.createElement('canvas'));
    this.referenceTexture.colorSpace = SRGBColorSpace;
    this.reference = projection(this.referenceTexture);
    this.preview = projection(this.videoTexture);
    (frame.getObjectByName('reference-view') as Mesh).material = this.reference;
    (frame.getObjectByName('cut-view') as Mesh).material = this.preview;

    const on = (id: string, action: () => void) => {
      const element = this.panel.requireElementById(id);
      element.name = id;
      element.addEventListener('click', action);
      this.cleanupFuncs.push(() => element.removeEventListener('click', action));
    };
    on('turn-left', () => this.turn(-5));
    on('turn-right', () => this.turn(5));
    on('replay-cut', () => this.replay());
    on('reset-yaw', () => this.reset());
    on('export-mp4', () => { void this.export(); });
    for (const id of ['hint', 'yaw-status', 'time-status', 'panel-surface']) {
      this.panel.requireElementById(id).name = id;
    }
    this.cleanupFuncs.push(this.queries.held.subscribe('qualify', () => {
      if (this.busy) { this.world.getSystem(GrabSystem)?.forceRelease(this.ring); return; }
      this.state.setValue(OrbitCutState, 'isDragging', true);
      const hand = this.world.getSystem(GrabSystem)?.getHolderHand(this.ring);
      const sources = this.world.renderer.xr.getSession()?.inputSources;
      const isHand = sources && Array.from(sources).some(source => source.handedness === hand && source.hand);
      this.state.setValue(OrbitCutState, 'inputKind', isHand ? 'hand-pinch' : 'controller');
      this.state.setValue(OrbitCutState, 'grabCount', (this.state.getValue(OrbitCutState, 'grabCount') ?? 0) + 1);
      void this.media.seek(Math.min(this.media.cutSeconds + 0.04, this.media.duration - 0.01)).catch(error => this.message(String(error)));
    }), this.queries.held.subscribe('disqualify', () => {
      this.state.setValue(OrbitCutState, 'isDragging', false);
    }));

    const fileInput = document.querySelector<HTMLInputElement>('#open-file')!;
    const cutInput = document.querySelector<HTMLInputElement>('#cut-seconds')!;
    const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
    const open = () => {
      const file = fileInput.files?.[0];
      if (file && !this.busy) void this.load(file);
    };
    const cut = () => {
      if (this.busy || !this.media.ready) return;
      const seconds = Number(cutInput.value);
      if (!(seconds > 0 && seconds < this.media.duration)) {
        cutInput.value = String(this.media.cutSeconds);
        this.message('Place the cut inside the video, in seconds.'); return;
      }
      this.media.cutSeconds = seconds;
      void this.captureReference().then(() => this.reset()).catch(error => this.message(String(error)));
    };
    const enter = () => { void this.world.launchXR(); };
    fileInput.addEventListener('change', open);
    cutInput.addEventListener('change', cut);
    xrButton.addEventListener('click', enter);
    this.cleanupFuncs.push(
      () => fileInput.removeEventListener('change', open),
      () => cutInput.removeEventListener('change', cut),
      () => xrButton.removeEventListener('click', enter),
      this.world.visibilityState.subscribe(state => {
        const immersive = state !== VisibilityState.NonImmersive;
        document.querySelector<HTMLElement>('#file-bar')!.style.display = immersive ? 'none' : 'flex';
        if (state === VisibilityState.Visible) this.recenterFrames = 3;
        if (state === VisibilityState.VisibleBlurred) this.media.video.pause();
      }),
      () => { this.media.destroy(); this.videoTexture.dispose(); this.referenceTexture.dispose(); this.preview.dispose(); this.reference.dispose(); if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl); },
    );
    void this.load();
  }

  private message(text: string): void {
    document.querySelector<HTMLElement>('#media-message')!.textContent = text;
    this.panel.requireElementById<UIKit.Text>('hint').setProperties({ text });
  }

  private async captureReference(): Promise<void> {
    await this.media.seek(Math.max(0, this.media.cutSeconds - 0.05));
    const canvas = this.referenceTexture.image as HTMLCanvasElement;
    canvas.width = this.media.video.videoWidth;
    canvas.height = this.media.video.videoHeight;
    canvas.getContext('2d')!.drawImage(this.media.video, 0, 0);
    this.referenceTexture.needsUpdate = true;
    await this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01));
  }

  private async load(file?: File): Promise<void> {
    this.busy = true;
    this.state.setValue(OrbitCutState, 'mediaReady', false);
    try {
      if (file) await this.media.openFile(file); else await this.media.openDemo();
      this.knownOffset = !file;
      this.state.setValue(OrbitCutState, 'sourceOffsetDegrees', file ? 0 : 55);
      await this.captureReference();
      const cutInput = document.querySelector<HTMLInputElement>('#cut-seconds')!;
      cutInput.value = String(this.media.cutSeconds);
      cutInput.max = String(this.media.duration - 0.05);
      this.state.setValue(OrbitCutState, 'mediaReady', true);
      this.applyYaw(0);
      this.message(file ? `${file.name}: turn the wheel, then replay the cut.` : 'Synthetic practice film: pinch the orange wheel and line up the beacon.');
    } catch (error) { this.message(String(error)); }
    finally { this.busy = false; }
  }

  private applyYaw(degrees: number): void {
    this.media.setYaw(degrees);
    const yaw = this.media.yawDegrees;
    const residual = ((yaw + (this.state.getValue(OrbitCutState, 'sourceOffsetDegrees') ?? 0) + 540) % 360) - 180;
    const aligned = this.knownOffset && Math.abs(residual) < 3;
    this.state.setValue(OrbitCutState, 'yawDegrees', yaw);
    this.state.setValue(OrbitCutState, 'residualDegrees', residual);
    this.state.setValue(OrbitCutState, 'aligned', aligned);
    this.ring.object3D!.rotation.set(0, yaw * Math.PI / 180, 0);
    this.panel.requireElementById<UIKit.Text>('yaw-status').setProperties({
      text: `${Math.round(yaw)} deg${this.knownOffset ? ` | ${aligned ? 'Beacon aligned' : `${Math.round(Math.abs(residual))} deg to align`}` : ' | Check the cut'}`,
      color: aligned ? '#9fdec9' : '#f5a15e',
    });
    this.panel.requireElementById('panel-surface').setProperties({ backgroundColor: aligned ? '#17473f' : '#171b35' });
  }

  private turn(degrees: number): void {
    if (this.busy || !this.media.ready) return;
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    this.state.setValue(OrbitCutState, 'inputKind', 'button');
    this.applyYaw(this.media.yawDegrees + degrees);
    void this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01));
  }

  private replay(): void {
    if (this.busy || !this.media.ready) return;
    this.state.setValue(OrbitCutState, 'cutCount', (this.state.getValue(OrbitCutState, 'cutCount') ?? 0) + 1);
    void this.media.playCut().catch(error => this.message(String(error)));
  }

  private reset(): void {
    if (this.busy || !this.media.ready) return;
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    this.applyYaw(0);
    this.state.setValue(OrbitCutState, 'inputKind', 'none');
    void this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01));
  }

  private async export(): Promise<void> {
    if (this.busy || !this.media.ready) return;
    this.busy = true;
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    this.message('Exporting the changed pixels in real time. Keep this tab open.');
    try {
      const blob = await this.media.exportMp4();
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = URL.createObjectURL(blob);
      const link = document.querySelector<HTMLAnchorElement>('#download')!;
      link.href = this.downloadUrl; link.hidden = false;
      link.click();
      this.message(`MP4 ready (${this.media.lastExportMimeType.replace('video/mp4;codecs=', '')}). Leave immersion to save again.`);
    } catch (error) { this.message(String(error)); }
    finally { this.busy = false; }
  }

  update(): void {
    if (this.recenterFrames > 0 && --this.recenterFrames === 0) {
      this.player.head.getWorldPosition(this.head);
      const offset = this.head.y - 1.6;
      for (const part of this.queries.parts.entities) part.object3D!.position.y += offset - this.benchOffsetY;
      this.anchor.y += offset - this.benchOffsetY;
      this.benchOffsetY = offset;
    }
    if (!this.busy && this.queries.held.entities.has(this.ring)) {
      this.wheelAngles.setFromQuaternion(this.ring.object3D!.quaternion, 'YXZ');
      const yaw = this.wheelAngles.y * 180 / Math.PI;
      if (Math.abs(yaw - this.media.yawDegrees) > 0.15) this.applyYaw(yaw);
      this.ring.object3D!.position.copy(this.anchor);
      this.ring.object3D!.rotation.set(0, this.media.yawDegrees * Math.PI / 180, 0);
    }
    const after = this.media.video.currentTime >= this.media.cutSeconds;
    const previewYaw = after ? this.media.yawDegrees : 0;
    this.preview.uniforms.yaw.value = previewYaw;
    if (this.lastPreviewYaw !== previewYaw) {
      this.lastPreviewYaw = previewYaw;
      this.state.setValue(OrbitCutState, 'previewYawDegrees', previewYaw);
      this.state.setValue(OrbitCutState, 'activeShot', after ? 'after' : 'before');
    }
  }
}
