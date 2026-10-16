import {
  BackSide, CanvasTexture, createSystem, Entity, FrontSide, Grabbed, GrabSystem, Mesh, Object3D,
  ShaderMaterial, Texture, UIKit, UIKitMLAsset,
  Vector3, VideoTexture, VisibilityState,
} from '@iwsdk/core';
import { OrbitCutState, WorkbenchPart, YawRing } from './orbit-components.js';
import { MediaSession } from './media.js';

// Both windows use the same 70-degree lens and fixed world-facing sight.
// Their source pixels are already display-encoded; bypass lighting and tone mapping equally.
function projection(texture: Texture, panoramic = false): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { frame: { value: texture }, yaw: { value: 0 }, panoramic: { value: panoramic } },
    vertexShader: `varying vec2 imageUv; varying vec3 surface;
      void main() { imageUv = uv; surface = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D frame; uniform float yaw; uniform bool panoramic;
      varying vec2 imageUv; varying vec3 surface;
      void main() {
        vec3 ray = normalize(panoramic ? surface : vec3((imageUv.x - 0.5) * 1.4004, (imageUv.y - 0.5) * 0.986, -1.0));
        vec2 sphereUv = vec2(fract(0.5 + atan(ray.x, -ray.z) / 6.2831853 - yaw / 360.0),
          0.5 + asin(ray.y) / 3.14159265);
        gl_FragColor = texture2D(frame, sphereUv);
      }`,
    toneMapped: false,
    side: panoramic ? BackSide : FrontSide,
    depthWrite: !panoramic,
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
  private optical!: Object3D;
  private panorama!: Mesh;
  private panoramaView!: ShaderMaterial;
  private videoTexture!: VideoTexture;
  private referenceTexture!: CanvasTexture;
  private holder: 'left' | 'right' | null = null;
  private grabHeading = 0;
  private grabYaw = 0;
  private direction = new Vector3();
  private anchor = new Vector3();
  private head = new Vector3();
  private benchOffsetY = 0;
  private recenterFrames = 0;
  private knownOffset = true;
  private sourceCuts: number[] = [4, 8];
  private sourceHeadings: number[] = [0, 55, -35];
  private reviewing = false;
  private corrected = true;
  private busy = false;
  private lastPreviewYaw = NaN;
  private lastReviewYaw = NaN;
  private lastActiveShot = '';
  private downloadUrl = '';

  init(): void {
    this.state = this.world.requireSceneEntity('orbit-cut-state');
    this.ring = this.world.requireSceneEntity('orbit-yaw-ring');
    this.anchor.copy(this.ring.object3D!.position);
    this.panel = this.world.requireSceneObject<UIKitMLAsset>('workbench-panel');
    const grabbing = this.world.getSystem(GrabSystem);
    if (grabbing) grabbing.config.useHandPinchForGrab.value = true;
    this.optical = this.world.requireSceneObject('optical-frame');
    this.panorama = this.world.requireSceneObject<Mesh>('panorama-screen');
    this.videoTexture = new VideoTexture(this.media.video);
    this.referenceTexture = new CanvasTexture(document.createElement('canvas'));
    this.reference = projection(this.referenceTexture);
    this.preview = projection(this.videoTexture);
    this.panoramaView = projection(this.videoTexture, true);
    this.panorama.material = this.panoramaView;
    (this.optical.getObjectByName('reference-view') as Mesh).material = this.reference;
    (this.optical.getObjectByName('cut-view') as Mesh).material = this.preview;

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
    on('cut-1', () => { void this.editCut(() => this.media.selectCut(0)); });
    on('cut-2', () => { void this.editCut(() => this.media.selectCut(1)); });
    on('add-cut', () => { void this.editCut(() => this.media.addCut()); });
    on('remove-cut', () => { void this.editCut(() => this.media.removeCut()); });
    on('earlier-second', () => this.moveCut(-1));
    on('earlier-frame', () => this.moveCut(-0.1));
    on('later-frame', () => this.moveCut(0.1));
    on('later-second', () => this.moveCut(1));
    on('review-panorama', () => { void this.toggleReview(); });
    on('review-original', () => this.compare(false));
    on('review-corrected', () => this.compare(true));
    on('review-replay', () => { void this.playReview(0); });
    on('review-pause', () => { if (!this.busy) void this.pauseReview(); });
    on('review-export', () => { void this.export(); });
    for (const id of ['hint', 'yaw-status', 'time-status', 'panel-surface']) {
      this.panel.requireElementById(id).name = id;
    }
    this.cleanupFuncs.push(this.queries.held.subscribe('qualify', () => {
      if (this.busy || this.reviewing) { this.world.getSystem(GrabSystem)?.forceRelease(this.ring); return; }
      this.state.setValue(OrbitCutState, 'isDragging', true);
      const hand = this.world.getSystem(GrabSystem)?.getHolderHand(this.ring);
      this.holder = hand ?? 'right';
      this.grabHeading = this.heading(this.holder);
      this.grabYaw = this.media.yawDegrees;
      const sources = this.world.renderer.xr.getSession()?.inputSources;
      const isHand = sources && Array.from(sources).some(source => source.handedness === hand && source.hand);
      this.state.setValue(OrbitCutState, 'inputKind', isHand ? 'hand-pinch' : 'controller');
      this.state.setValue(OrbitCutState, 'grabCount', (this.state.getValue(OrbitCutState, 'grabCount') ?? 0) + 1);
      void this.media.seek(Math.min(this.media.cutSeconds + 0.04, this.media.duration - 0.01)).catch(error => this.message(String(error)));
    }), this.queries.held.subscribe('disqualify', () => {
      this.state.setValue(OrbitCutState, 'isDragging', false);
      this.holder = null;
    }));

    const fileInput = document.querySelector<HTMLInputElement>('#open-file')!;
    const cutInput = document.querySelector<HTMLInputElement>('#cut-seconds')!;
    const xrButton = document.querySelector<HTMLButtonElement>('#enter-xr')!;
    const practiceButton = document.querySelector<HTMLButtonElement>('#practice-waterfall')!;
    const open = () => {
      const file = fileInput.files?.[0];
      if (file && !this.busy) void this.load(file);
    };
    const cut = () => {
      if (this.busy || !this.media.ready) return;
      const seconds = Number(cutInput.value);
      void this.editCut(() => { this.media.cutSeconds = seconds; });
    };
    const enter = () => { void this.world.launchXR(); };
    const practice = () => { void this.loadPractice(); };
    fileInput.addEventListener('change', open);
    cutInput.addEventListener('change', cut);
    xrButton.addEventListener('click', enter);
    practiceButton.addEventListener('click', practice);
    const playback = () => this.panel.requireElementById<UIKit.Text>('pause-label').setProperties({
      text: this.media.video.paused ? 'Play' : 'Pause',
    });
    this.media.video.addEventListener('pause', playback);
    this.media.video.addEventListener('play', playback);
    this.cleanupFuncs.push(
      () => fileInput.removeEventListener('change', open),
      () => cutInput.removeEventListener('change', cut),
      () => xrButton.removeEventListener('click', enter),
      () => practiceButton.removeEventListener('click', practice),
      () => this.media.video.removeEventListener('pause', playback),
      () => this.media.video.removeEventListener('play', playback),
      this.world.visibilityState.subscribe(state => {
        const immersive = state !== VisibilityState.NonImmersive;
        document.querySelector<HTMLElement>('#file-bar')!.style.display = immersive ? 'none' : 'flex';
        if (state === VisibilityState.Visible) this.recenterFrames = 3;
        if (state === VisibilityState.VisibleBlurred) this.media.video.pause();
      }),
      () => { this.media.destroy(); this.videoTexture.dispose(); this.referenceTexture.dispose(); this.preview.dispose(); this.reference.dispose(); this.panoramaView.dispose(); if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl); },
    );
    void this.load();
  }

  private message(text: string): void {
    document.querySelector<HTMLElement>('#media-message')!.textContent = text;
    this.panel.requireElementById<UIKit.Text>('hint').setProperties({ text });
  }

  private async captureReference(): Promise<void> {
    await this.media.seek(Math.max(0, this.media.cutSeconds - 0.05));
    const canvas = document.createElement('canvas');
    canvas.width = this.media.video.videoWidth;
    canvas.height = this.media.video.videoHeight;
    canvas.getContext('2d')!.drawImage(this.media.video, 0, 0);
    // Texture dimensions are immutable after GPU allocation; replace on a new frame size.
    this.referenceTexture.dispose();
    this.referenceTexture = new CanvasTexture(canvas);
    this.reference.uniforms.frame.value = this.referenceTexture;
    this.reference.uniforms.yaw.value = this.media.referenceYawDegrees;
    this.state.setValue(OrbitCutState, 'referenceYawDegrees', this.media.referenceYawDegrees);
    await this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01));
  }

  private syncCut(): void {
    const index = this.media.selectedCutIndex;
    const cuts = this.media.cuts;
    this.knownOffset = cuts.every((cut, i) => Math.abs(cut.seconds - (this.sourceCuts[i] ?? -1)) < 0.01);
    const offset = this.knownOffset ? this.sourceHeadings[index + 1] - this.sourceHeadings[index] - this.media.referenceYawDegrees : 0;
    this.state.setValue(OrbitCutState, 'sourceOffsetDegrees', offset);
    this.state.setValue(OrbitCutState, 'selectedCut', index);
    this.state.setValue(OrbitCutState, 'totalCuts', cuts.length);
    this.state.setValue(OrbitCutState, 'cutSeconds', this.media.cutSeconds);
    for (let i = 0; i < 2; i++) {
      this.panel.requireElementById(`cut-${i + 1}`).setProperties({
        display: cuts[i] ? 'flex' : 'none', backgroundColor: i === index ? '#5c507b' : '#292e50',
      });
      this.panel.requireElementById<UIKit.Text>(`cut-${i + 1}-label`).setProperties({ text: `Cut ${i + 1}   ${cuts[i]?.seconds.toFixed(1) ?? ''} s` });
    }
    this.panel.requireElementById('add-cut').setProperties({ display: cuts.length < 2 ? 'flex' : 'none' });
    this.panel.requireElementById('remove-cut').setProperties({ display: cuts.length > 1 ? 'flex' : 'none' });
    this.panel.requireElementById<UIKit.Text>('time-status').setProperties({ text: `Previous shot | Shot ${index + 2}` });
    const input = document.querySelector<HTMLInputElement>('#cut-seconds')!;
    input.value = this.media.cutSeconds.toFixed(1);
    input.min = String((cuts[index - 1]?.seconds ?? 0) + 0.1);
    input.max = String((cuts[index + 1]?.seconds ?? this.media.duration) - 0.1);
    this.applyYaw(this.media.yawDegrees);
  }

  private async editCut(edit: () => void): Promise<void> {
    if (this.busy || !this.media.ready) return;
    this.busy = true;
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    try {
      edit();
      await this.captureReference();
      this.syncCut();
      this.message('Line up the next shot with the corrected previous shot.');
    } catch (error) {
      document.querySelector<HTMLInputElement>('#cut-seconds')!.value = this.media.cutSeconds.toFixed(1);
      this.message(String(error));
    } finally { this.busy = false; }
  }

  private moveCut(delta: number): void {
    void this.editCut(() => { this.media.cutSeconds = Math.round((this.media.cutSeconds + delta) * 10) / 10; });
  }

  private setReview(visible: boolean): void {
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    this.reviewing = visible;
    this.panorama.visible = visible;
    this.optical.visible = !visible;
    this.ring.object3D!.visible = !visible;
    this.panel.position.y = 1.8 + this.benchOffsetY - (visible ? 0.5 : 0);
    for (const id of ['cut-controls', 'boundary-controls', 'yaw-row', 'turn-row']) {
      this.panel.requireElementById(id).setProperties({ display: visible ? 'none' : 'flex' });
    }
    for (const id of ['review-controls', 'review-status']) {
      this.panel.requireElementById(id).setProperties({ display: visible ? 'flex' : 'none' });
    }
    this.panel.requireElementById<UIKit.Text>('review-label').setProperties({ text: visible ? 'Back to edit' : 'Review 360' });
    this.state.setValue(OrbitCutState, 'panoramaVisible', visible);
    this.compare(true);
  }

  private async toggleReview(): Promise<void> {
    if (this.busy || !this.media.ready) return;
    this.setReview(!this.reviewing);
    if (this.reviewing) await this.playReview(0);
    else await this.editCut(() => this.media.selectCut(this.media.selectedCutIndex));
  }

  private compare(corrected: boolean): void {
    this.corrected = corrected;
    this.state.setValue(OrbitCutState, 'correctedReview', corrected);
    this.panel.requireElementById('review-original').setProperties({ backgroundColor: corrected ? '#292e50' : '#5c507b' });
    this.panel.requireElementById('review-corrected').setProperties({ backgroundColor: corrected ? '#17473f' : '#292e50' });
    this.panel.requireElementById<UIKit.Text>('review-status').setProperties({
      text: corrected ? 'Corrected panorama. Each shot keeps its own direction.' : 'Original panorama. The viewing direction stays the same.',
    });
  }

  private async playReview(seconds: number): Promise<void> {
    if (this.busy || !this.media.ready) return;
    this.busy = true;
    try {
      await this.media.playFrom(seconds);
      this.message('Look around. Compare Original and Corrected without moving your head.');
    } catch (error) { this.message(String(error)); }
    finally { this.busy = false; }
  }

  private async pauseReview(): Promise<void> {
    if (this.media.video.paused) await this.playReview(this.media.video.ended ? 0 : this.media.video.currentTime);
    else this.media.video.pause();
  }

  private async loadPractice(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message('Loading the waterfall practice film...');
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}media/waterfall-practice.mp4`);
      if (!response.ok) throw new Error('Practice film failed to load. Try again.');
      await this.load(new File([await response.blob()], 'Waterfall practice.mp4', { type: 'video/mp4' }), true);
    } catch (error) { this.message(String(error)); }
    finally { this.busy = false; }
  }

  private async load(file?: File, practice = false): Promise<void> {
    this.busy = true;
    this.setReview(false);
    this.state.setValue(OrbitCutState, 'mediaReady', false);
    try {
      if (file) await this.media.openFile(file);
      else {
        const response = await fetch(`${import.meta.env.BASE_URL}media/orbit-two-cuts.mp4`);
        if (!response.ok) throw new Error('Practice film failed to load. Reload to retry.');
        await this.media.openFile(new File([await response.blob()], 'Two-cut synthetic practice.mp4', { type: 'video/mp4' }));
        this.media.cutSeconds = 4;
        this.media.addCut();
        this.media.selectCut(0);
      }
      this.videoTexture.dispose();
      this.videoTexture = new VideoTexture(this.media.video);
      this.preview.uniforms.frame.value = this.videoTexture;
      this.panoramaView.uniforms.frame.value = this.videoTexture;
      this.sourceCuts = !file ? [4, 8] : practice ? [5] : [];
      this.sourceHeadings = !file ? [0, 55, -35] : practice ? [0, 55] : [];
      if (practice) this.media.cutSeconds = 5;
      await this.captureReference();
      this.state.setValue(OrbitCutState, 'mediaReady', true);
      this.syncCut();
      document.querySelector<HTMLElement>('#sample-credit')!.hidden = !practice;
      this.message(practice ? 'Waterfall practice: turn until the path lines up.' : file ? `${file.name}: set a cut, turn the wheel, then add another.` : 'Pinch and turn the wheel. Align Cut 1, then Cut 2. Review in 360.');
    } catch (error) { this.message(String(error)); }
    finally { this.busy = false; }
  }

  private heading(hand: 'left' | 'right'): number {
    this.player.raySpaces[hand].getWorldDirection(this.direction);
    return Math.atan2(this.direction.x, this.direction.z) * 180 / Math.PI;
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
    void this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01)).catch(error => this.message(String(error)));
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
    void this.media.seek(Math.min(this.media.cutSeconds + 0.05, this.media.duration - 0.01)).catch(error => this.message(String(error)));
  }

  private async export(): Promise<void> {
    if (this.busy || !this.media.ready) return;
    this.busy = true;
    this.world.getSystem(GrabSystem)?.forceRelease(this.ring);
    this.message('Exporting all corrected shots in real time. Keep this tab open.');
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
    if (!this.busy && this.holder && this.queries.held.entities.has(this.ring)) {
      const delta = ((this.heading(this.holder) - this.grabHeading + 540) % 360) - 180;
      const yaw = this.grabYaw + delta;
      if (Math.abs(yaw - this.media.yawDegrees) > 0.15) this.applyYaw(yaw);
      this.ring.object3D!.position.copy(this.anchor);
      this.ring.object3D!.rotation.set(0, this.media.yawDegrees * Math.PI / 180, 0);
    }
    const time = this.media.video.currentTime;
    const previewYaw = this.media.yawAt(time);
    this.preview.uniforms.yaw.value = previewYaw;
    const reviewYaw = this.corrected ? previewYaw : 0;
    this.panoramaView.uniforms.yaw.value = reviewYaw;
    if (this.reviewing) {
      this.player.head.getWorldPosition(this.head);
      this.panorama.position.copy(this.head);
    }
    if (this.lastReviewYaw !== reviewYaw) {
      this.lastReviewYaw = reviewYaw;
      this.state.setValue(OrbitCutState, 'reviewYawDegrees', reviewYaw);
    }
    if (this.lastPreviewYaw !== previewYaw) {
      this.lastPreviewYaw = previewYaw;
      this.state.setValue(OrbitCutState, 'previewYawDegrees', previewYaw);
    }
    const activeShot = time >= (this.media.cuts[1]?.seconds ?? Infinity) ? 'shot-3' : time >= this.media.cuts[0].seconds ? 'shot-2' : 'shot-1';
    if (this.lastActiveShot !== activeShot) {
      this.lastActiveShot = activeShot;
      this.state.setValue(OrbitCutState, 'activeShot', activeShot);
    }
  }
}
