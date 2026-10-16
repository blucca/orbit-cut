/** Local 2:1 equirectangular MP4 editing. Demo footage is explicitly synthetic. */
type Cut = Readonly<{ seconds: number; yawDegrees: number }>;

export class MediaSession {
  readonly video = document.createElement('video');
  ready = false;

  private cutList: ReadonlyArray<Cut> = Object.freeze([Object.freeze({ seconds: 6, yawDegrees: 0 })]);
  private cutIndex = 0;
  private objectUrl?: string;
  private recording = false;
  private exportMimeType = '';
  private audioContext?: AudioContext;
  private audioSource?: MediaElementAudioSourceNode;
  private previewGain?: GainNode;
  private cancelExport?: () => void;

  constructor() {
    this.video.preload = 'auto';
    this.video.playsInline = true;
    this.video.crossOrigin = 'anonymous';
    this.video.muted = true;
  }

  get duration(): number {
    return this.ready ? this.video.duration : 0;
  }

  get lastExportMimeType(): string {
    return this.exportMimeType;
  }

  get cuts(): ReadonlyArray<Cut> {
    return this.cutList;
  }

  get selectedCutIndex(): number {
    return this.cutIndex;
  }

  get cutSeconds(): number {
    return this.cutList[this.cutIndex].seconds;
  }

  set cutSeconds(seconds: number) {
    this.requireEditable();
    this.requireReady();
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= this.duration) {
      throw new Error('Place the cut inside the video, in seconds.');
    }
    const previous = this.cutList[this.cutIndex - 1];
    const next = this.cutList[this.cutIndex + 1];
    if ((previous && seconds < previous.seconds + 0.1) || (next && seconds > next.seconds - 0.1)) {
      throw new Error('Keep cuts in order, at least 0.1 seconds apart.');
    }
    this.replaceCut({ seconds, yawDegrees: this.yawDegrees });
  }

  get yawDegrees(): number {
    return this.cutList[this.cutIndex].yawDegrees;
  }

  get referenceYawDegrees(): number {
    return this.cutIndex > 0 ? this.cutList[this.cutIndex - 1].yawDegrees : 0;
  }

  yawAt(seconds: number): number {
    return yawAtTime(this.cutList, seconds);
  }

  selectCut(index: number): void {
    this.requireEditable();
    if (!Number.isInteger(index) || index < 0 || index >= this.cutList.length) {
      throw new Error('Choose an existing cut.');
    }
    this.cutIndex = index;
  }

  addCut(): void {
    this.requireEditable();
    this.requireReady();
    if (this.cutList.length >= 2) throw new Error('This workbench supports two cuts.');
    const last = this.cutList[this.cutList.length - 1];
    const seconds = (last.seconds + this.duration) / 2;
    if (seconds < last.seconds + 0.1) throw new Error('Leave at least 0.2 seconds after the last cut before adding another.');
    this.cutList = Object.freeze([...this.cutList, Object.freeze({ seconds, yawDegrees: last.yawDegrees })]);
    this.cutIndex = this.cutList.length - 1;
  }

  removeCut(): void {
    this.requireEditable();
    if (this.cutList.length === 1) throw new Error('Keep at least one cut in the film.');
    this.cutList = Object.freeze(this.cutList.filter((_cut, index) => index !== this.cutIndex));
    this.cutIndex = Math.min(this.cutIndex, this.cutList.length - 1);
  }

  async openDemo(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    await this.open(`${base}media/orbit-demo.mp4`);
    this.cutSeconds = Math.min(6, this.duration / 2);
  }

  async openFile(file: File): Promise<void> {
    this.requireEditable();
    if (!file.size || !(/\.mp4$/i.test(file.name) || file.type === 'video/mp4')) {
      throw new Error('Choose an MP4 video with a 2:1 equirectangular image.');
    }
    await this.open(URL.createObjectURL(file), true);
  }

  setYaw(degrees: number): void {
    this.requireEditable();
    if (!Number.isFinite(degrees)) throw new Error('Yaw must be a finite number.');
    // Positive yaw rolls image pixels to the right, toward positive longitude.
    this.replaceCut({ seconds: this.cutSeconds, yawDegrees: ((degrees + 180) % 360 + 360) % 360 - 180 });
  }

  async seek(seconds: number): Promise<void> {
    this.requireReady();
    this.requireEditable();
    if (!Number.isFinite(seconds)) throw new Error('Choose a finite video time.');
    this.video.pause();
    await seekVideo(this.video, Math.max(0, Math.min(seconds, this.duration - 0.001)));
  }

  playCut(): Promise<void> {
    return this.playFrom(Math.max(0, this.cutSeconds - 2));
  }

  async playFrom(seconds: number): Promise<void> {
    this.requireReady();
    this.requireEditable();
    if (!Number.isFinite(seconds)) throw new Error('Choose a finite video time.');
    const resumed = this.audioContext?.resume();
    const sought = this.seek(seconds);
    this.video.muted = false;
    await Promise.all([resumed, sought, this.video.play()]);
  }

  async exportMp4(): Promise<Blob> {
    this.requireReady();
    this.requireEditable();
    const cuts = this.cutList;
    const mimeType = [
      'video/mp4;codecs=avc1.420033,mp4a.40.2',
      'video/mp4',
    ].find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream || typeof AudioContext === 'undefined') {
      throw new Error('This browser has no native MP4 recorder. Open Orbit Cut in a recent Chrome or Edge browser.');
    }

    const video = this.video;
    const oldTime = video.currentTime;
    const oldMuted = video.muted;
    const oldVolume = video.volume;
    const oldRate = video.playbackRate;
    let audioDestination: MediaStreamAudioDestinationNode | undefined;
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let frameHandle = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onEnded: (() => void) | undefined;
    let onError: (() => void) | undefined;
    const videoFrames = typeof video.requestVideoFrameCallback === 'function';
    this.recording = true;
    video.pause();

    try {
      // Native Web Audio keeps the decoded soundtrack tied to normal-speed playback.
      this.audioContext ??= new AudioContext();
      if (!this.audioSource) {
        this.audioSource = this.audioContext.createMediaElementSource(video);
        this.previewGain = this.audioContext.createGain();
        this.audioSource.connect(this.previewGain).connect(this.audioContext.destination);
      }
      audioDestination = this.audioContext.createMediaStreamDestination();
      this.audioSource.connect(audioDestination);
      this.previewGain!.gain.value = 0;
      await this.audioContext.resume();
      await seekVideo(video, 0);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('The browser could not allocate an export canvas. Try a smaller MP4.');
      // ponytail: real-time native recording, capped at 30 fps; use an offline pipeline for frame-exact mastering.
      stream = canvas.captureStream(30);
      for (const track of audioDestination.stream.getAudioTracks()) stream.addTrack(track);
      const draw = (time: number) => {
        const width = canvas.width;
        const shift = ((Math.round(width * yawAtTime(cuts, time) / 360) % width) + width) % width;
        context.drawImage(video, shift, 0, width, canvas.height);
        if (shift) context.drawImage(video, shift - width, 0, width, canvas.height);
      };
      const nextFrame = () => {
        frameHandle = videoFrames
          ? video.requestVideoFrameCallback((_now, info) => { draw(info.mediaTime); nextFrame(); })
          : requestAnimationFrame(() => { draw(video.currentTime); nextFrame(); });
      };
      draw(0);
      nextFrame();
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
      const chunks: Blob[] = [];
      const result = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder!.onerror = () => reject(new Error('The browser stopped recording. Try a shorter or smaller MP4.'));
        recorder!.onstop = () => {
          const blob = new Blob(chunks, { type: recorder!.mimeType });
          if (blob.size) resolve(blob);
          else reject(new Error('The MP4 recorder returned an empty video.'));
        };
        onEnded = () => { if (recorder!.state !== 'inactive') recorder!.stop(); };
        onError = () => reject(new Error('Video decoding stopped during export.'));
        video.addEventListener('ended', onEnded, { once: true });
        video.addEventListener('error', onError, { once: true });
        this.cancelExport = () => reject(new Error('MP4 export cancelled.'));
        timeout = setTimeout(() => reject(new Error('Export timed out. Keep this tab visible and try again.')), (video.duration + 20) * 1000);
      });
      recorder.start(1000);
      video.muted = false;
      video.volume = 1;
      video.playbackRate = 1;
      const [, blob] = await Promise.all([video.play(), result]);
      this.exportMimeType = blob.type;
      return await tagSphericalMp4(blob);
    } finally {
      this.cancelExport = undefined;
      if (timeout) clearTimeout(timeout);
      if (videoFrames) video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      video.pause();
      if (onEnded) video.removeEventListener('ended', onEnded);
      if (onError) video.removeEventListener('error', onError);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (audioDestination) {
        this.audioSource?.disconnect(audioDestination);
        for (const track of audioDestination.stream.getTracks()) track.stop();
      }
      if (this.previewGain) this.previewGain.gain.value = 1;
      video.muted = oldMuted;
      video.volume = oldVolume;
      video.playbackRate = oldRate;
      try {
        if (this.ready && !video.error) await seekVideo(video, oldTime);
      } finally { this.recording = false; }
    }
  }

  destroy(): void {
    this.cancelExport?.();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    void this.audioContext?.close();
    this.ready = false;
  }

  private requireReady(): void {
    if (!this.ready) throw new Error('Load a 2:1 MP4 video first.');
  }

  private requireEditable(): void {
    if (this.recording) throw new Error('Wait for the MP4 export to finish.');
  }

  private replaceCut(cut: Cut): void {
    this.cutList = Object.freeze(this.cutList.map((previous, index) => index === this.cutIndex ? Object.freeze(cut) : previous));
  }

  private async open(url: string, owned = false): Promise<void> {
    this.requireEditable();
    this.ready = false;
    this.video.pause();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = owned ? url : undefined;
    const loaded = mediaEvent(this.video, 'loadeddata');
    this.video.src = url;
    this.video.load();
    await loaded;
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) throw new Error('The MP4 has no playable duration.');
    if (Math.abs(this.video.videoWidth / this.video.videoHeight - 2) > 0.05) {
      throw new Error('Choose a monoscopic 360° MP4 with a 2:1 equirectangular image.');
    }
    this.cutList = Object.freeze([Object.freeze({ seconds: this.video.duration / 2, yawDegrees: 0 })]);
    this.cutIndex = 0;
    this.ready = true;
  }
}

function yawAtTime(cuts: ReadonlyArray<Cut>, seconds: number): number {
  let yaw = 0;
  for (const cut of cuts) {
    if (seconds < cut.seconds) break;
    yaw = cut.yawDegrees;
  }
  return yaw;
}

function mediaEvent(video: HTMLVideoElement, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('This MP4 could not be decoded. Try an H.264/AAC MP4.')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Video loading timed out. Try loading the MP4 again.')); }, 20_000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(name, finish);
      video.removeEventListener('error', failed);
    };
    video.addEventListener(name, finish, { once: true });
    video.addEventListener('error', failed, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (Math.abs(video.currentTime - seconds) < 0.001 && video.readyState >= 2) return;
  const seeked = mediaEvent(video, 'seeked');
  video.currentTime = seconds;
  await seeked;
}

type Mp4Box = { start: number; end: number; body: number; type: string };

function mp4Boxes(view: DataView, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  while (start < end) {
    if (start + 8 > end) throw new Error('The recorder returned a truncated MP4 box.');
    const size32 = view.getUint32(start);
    const header = size32 === 1 ? 16 : 8;
    if (start + header > end) throw new Error('The recorder returned a truncated MP4 header.');
    const size = size32 === 1 ? Number(view.getBigUint64(start + 8)) : size32 || end - start;
    if (!Number.isSafeInteger(size) || size < header || start + size > end) throw new Error('The recorder returned an invalid MP4 box size.');
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + start + 4, 4));
    boxes.push({ start, end: start + size, body: start + header, type });
    start += size;
  }
  return boxes;
}

/** Tag the newly recorded, full-frame mono panorama without re-encoding it.
 * Spatial Media v1: https://github.com/google/spatial-media/blob/master/docs/spherical-video-rfc.md
 */
export async function tagSphericalMp4(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const children = (box: Mp4Box) => mp4Boxes(view, box.body, box.end);
  const top = mp4Boxes(view, 0, bytes.length);
  const movies = top.filter(box => box.type === 'moov');
  if (movies.length !== 1) throw new Error('The recorder returned an MP4 without one movie header.');
  const movie = movies[0];
  const videos = children(movie).filter(track => track.type === 'trak' && children(track).some(media =>
    media.type === 'mdia' && children(media).some(handler => handler.type === 'hdlr' &&
      handler.body + 12 <= handler.end && view.getUint32(handler.body + 8) === 0x76696465)));
  if (videos.length !== 1) throw new Error('360 export needs exactly one recorded video track.');
  const video = videos[0];
  const xml = new TextEncoder().encode('<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">' +
    '<GSpherical:Spherical>true</GSpherical:Spherical><GSpherical:Stitched>true</GSpherical:Stitched>' +
    '<GSpherical:StitchingSoftware>Orbit Cut</GSpherical:StitchingSoftware>' +
    '<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>' +
    '<GSpherical:StereoMode>mono</GSpherical:StereoMode></rdf:SphericalVideo>');
  const metadata = new Uint8Array(24 + xml.length);
  new DataView(metadata.buffer).setUint32(0, metadata.length);
  metadata.set([0x75, 0x75, 0x69, 0x64, 0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93,
    0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd], 4);
  metadata.set(xml, 24);
  const insertion = video.end;
  const delta = metadata.length;
  const shiftOffset = (position: number, width: number, end: number) => {
    if (position + width > end) throw new Error('The recorder returned a truncated MP4 index.');
    let offset = width === 8 ? view.getBigUint64(position) : BigInt(view.getUint32(position));
    if (offset < BigInt(insertion)) return;
    offset += BigInt(delta);
    if (width === 8) view.setBigUint64(position, offset);
    else {
      if (offset > 0xffffffffn) throw new Error('This MP4 is too large for its 32-bit index. Try a shorter clip.');
      view.setUint32(position, Number(offset));
    }
  };
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mfra']);
  const patch = (box: Mp4Box): void => {
    if (containers.has(box.type)) { children(box).forEach(patch); return; }
    if (box.type === 'stco' || box.type === 'co64') {
      const width = box.type === 'co64' ? 8 : 4;
      if (box.body + 8 > box.end) throw new Error('The recorder returned a truncated MP4 chunk index.');
      const count = view.getUint32(box.body + 4);
      if (box.body + 8 + count * width > box.end) throw new Error('The recorder returned an invalid MP4 chunk count.');
      for (let i = 0; i < count; i++) shiftOffset(box.body + 8 + i * width, width, box.end);
    } else if (box.type === 'tfhd') {
      // ponytail: native Chromium fragments use moof-relative data; add other muxers when needed.
      if (box.body + 8 > box.end || (view.getUint32(box.body) & 0x020001) !== 0x020000) {
        throw new Error('360 tagging needs moof-relative MP4 fragments. Try a recent Chrome browser.');
      }
    } else if (box.type === 'tfra') {
      if (box.body + 16 > box.end || view.getUint8(box.body) > 1) throw new Error('The recorder returned an unsupported MP4 seek index.');
      const width = view.getUint8(box.body) === 1 ? 8 : 4;
      const sizes = view.getUint32(box.body + 8);
      const entrySize = width * 2 + ((sizes >> 4) & 3) + ((sizes >> 2) & 3) + (sizes & 3) + 3;
      const count = view.getUint32(box.body + 12);
      if (box.body + 16 + count * entrySize > box.end) throw new Error('The recorder returned an invalid MP4 seek count.');
      for (let i = 0; i < count; i++) shiftOffset(box.body + 16 + i * entrySize + width, width, box.end);
    } else if (box.type === 'sidx') {
      throw new Error('360 tagging does not yet support this recorder’s segment index. Try a recent Chrome browser.');
    }
  };
  top.forEach(patch);
  for (const box of [movie, video]) {
    const size = box.end - box.start + delta;
    if (view.getUint32(box.start) === 1) view.setBigUint64(box.start + 8, BigInt(size));
    else {
      if (size > 0xffffffff) throw new Error('The MP4 movie header is too large.');
      view.setUint32(box.start, size);
    }
  }
  return new Blob([bytes.subarray(0, insertion), metadata, bytes.subarray(insertion)], { type: blob.type });
}
