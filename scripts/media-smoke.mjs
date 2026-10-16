/** Native browser MP4 import → pixel yaw export → reopen, without IWSDK or Vite.
 * Requires FFmpeg for the small moving synthetic fixture.
 * npm ci && npx playwright install chromium
 * ORBIT_MEDIA_OUTPUT=/path/to/workspace/temp/media node scripts/media-smoke.mjs
 * CHROMIUM_PATH=/usr/bin/chromium optionally uses a system browser.
 * node scripts/media-smoke.mjs --timeline-only checks edits without a browser.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'src/media.ts'), 'utf8');
const module = ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL', "'/'"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const { MediaSession } = await import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`);
// Only the edit model needs a video with a duration; native decoding is checked below.
globalThis.document = { createElement: () => ({ duration: 12 }) };
const timeline = new MediaSession();
delete globalThis.document;
timeline.ready = true;
const initialSnapshot = timeline.cuts;
timeline.cutSeconds = 4;
timeline.setYaw(55);
timeline.addCut();
assert.equal(timeline.selectedCutIndex, 1);
assert.deepEqual(timeline.cuts, [{ seconds: 4, yawDegrees: 55 }, { seconds: 8, yawDegrees: 55 }]);
timeline.setYaw(-35);
timeline.cutSeconds = 9;
assert.equal(timeline.referenceYawDegrees, 55);
assert.deepEqual([3.99, 4, 8.99, 9, 11].map(time => timeline.yawAt(time)), [0, 55, 55, -35, -35]);
timeline.selectCut(0);
assert.equal(timeline.referenceYawDegrees, 0);
assert.equal(timeline.yawDegrees, 55, 'changing cut 2 keeps cut 1 correction');
const editedSnapshot = timeline.cuts;
for (const seconds of [NaN, Infinity, -1, 0, 12, 8.95, 9, 10]) {
  assert.throws(() => { timeline.cutSeconds = seconds; });
  assert.equal(timeline.cuts, editedSnapshot, 'rejected time keeps the snapshot');
}
timeline.cutSeconds = 8.9; // The exact minimum gap is valid.
timeline.selectCut(1);
assert.throws(() => { timeline.cutSeconds = 8.95; });
assert.throws(() => { timeline.cutSeconds = 8; });
assert.equal(timeline.cutSeconds, 9);
assert.throws(() => timeline.setYaw(NaN));
assert.equal(timeline.yawDegrees, -35);
for (const index of [-1, 2, 0.5, NaN]) assert.throws(() => timeline.selectCut(index));
assert.throws(() => timeline.addCut());
assert.throws(() => { timeline.cuts[0].yawDegrees = 1; });
assert.throws(() => timeline.cuts.push({ seconds: 10, yawDegrees: 1 }));
assert.deepEqual(initialSnapshot, [{ seconds: 6, yawDegrees: 0 }], 'old snapshots keep their values');
timeline.selectCut(0);
timeline.cutSeconds = 4;
timeline.selectCut(1);
timeline.removeCut();
assert.deepEqual(timeline.cuts, [{ seconds: 4, yawDegrees: 55 }]);
assert.equal(timeline.selectedCutIndex, 0);
assert.throws(() => timeline.removeCut());
timeline.addCut();
timeline.selectCut(0);
timeline.removeCut();
assert.deepEqual(timeline.cuts, [{ seconds: 8, yawDegrees: 55 }]);
assert.equal(timeline.referenceYawDegrees, 0);
timeline.cutSeconds = 11.9;
assert.throws(() => timeline.addCut(), 'a short final segment has no room for the midpoint cut');
const timelineChecks = { independentYaw: true, absoluteSegments: true, referenceYaw: true, immutableSnapshots: true, boundaryRejection: true, addRemoveSelection: true };
if (process.argv.includes('--timeline-only')) {
  console.log(JSON.stringify({ timelineChecks }, null, 2));
  process.exit(0);
}
const out = path.resolve(process.env.ORBIT_MEDIA_OUTPUT ?? path.join(root, 'temp/media-smoke'));
await mkdir(out, { recursive: true });
const motionPath = path.join(out, 'moving-source.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=12:duration=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1',
  '-c:a', 'aac', '-shortest', motionPath,
]);
const motionFixture = await readFile(motionPath);
const fixture = await readFile(path.join(root, 'public/media/orbit-demo.mp4'));
const metadata = JSON.parse(await readFile(path.join(root, 'public/media/demo.json'), 'utf8'));
const server = createServer((req, res) => {
  const media = req.url === '/media/orbit-demo.mp4' || req.url === '/motion.mp4';
  if (!['/', '/media.js', '/media/orbit-demo.mp4', '/motion.mp4'].includes(req.url)) { res.writeHead(404).end(); return; }
  const body = media ? (req.url === '/motion.mp4' ? motionFixture : fixture) : Buffer.from(req.url === '/media.js' ? module : '<title>Orbit Cut native media check</title>');
  const range = media && req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Number(range[2]) : body.length - 1;
  const headers = { 'Content-Type': media ? 'video/mp4' : req.url === '/media.js' ? 'text/javascript' : 'text/html', 'Content-Length': end - start + 1 };
  if (media) headers['Accept-Ranges'] = 'bytes';
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(range ? 206 : 200, headers);
  res.end(body.subarray(start, end + 1));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async (metadata) => {
    const { MediaSession } = await import('/media.js');
    const media = new MediaSession();
    document.body.append(media.video);
    media.video.style.width = '512px';
    await media.openDemo();
    const frame = async (session, time, yaw = 0) => {
      await session.seek(time);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const shift = ((Math.round(256 * yaw / 360) % 256) + 256) % 256;
      context.drawImage(session.video, shift, 0, 256, 128);
      if (shift) context.drawImage(session.video, shift - 256, 0, 256, 128);
      return context.getImageData(0, 0, 256, 128).data;
    };
    const difference = (left, right) => {
      let sum = 0;
      for (let i = 0; i < left.length; i++) if (i % 4 !== 3) sum += Math.abs(left[i] - right[i]);
      return sum / (left.length * 0.75);
    };
    const base64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return btoa(binary);
    };
    // A failed native constructor must release the edit lock before any retry.
    const initializationRecovery = [];
    for (const name of ['AudioContext', 'MediaRecorder']) {
      const Native = window[name];
      window[name] = class extends Native { constructor() { throw new Error('Expected initialization failure'); } };
      try {
        await media.exportMp4();
        throw new Error(`${name} failure was swallowed`);
      } catch (error) {
        if (error.message !== 'Expected initialization failure') throw error;
      } finally { window[name] = Native; }
      await media.seek(1);
      initializationRecovery.push(name);
    }
    const before = await frame(media, 1);
    const after = await frame(media, 9);
    media.setYaw(-metadata.exact_heading_discontinuity_degrees);
    const start = performance.now();
    const blob = await media.exportMp4();
    const exportWallSeconds = (performance.now() - start) / 1000;
    const restoredTime = media.video.currentTime;
    const reopened = new MediaSession();
    document.body.append(reopened.video);
    reopened.video.style.width = '512px';
    await reopened.openFile(new File([blob], 'orbit-corrected.mp4', { type: blob.type }));
    const correctedBefore = await frame(reopened, 1);
    const correctedAfter = await frame(reopened, 9);
    const audio = new AudioContext();
    const decodedAudio = await audio.decodeAudioData(await blob.arrayBuffer());
    const samples = decodedAudio.getChannelData(0);
    let squares = 0;
    for (const sample of samples) squares += sample * sample;
    const measurements = {
      fixtureSource: metadata.source,
      recorderSupport: ['video/mp4', 'video/mp4;codecs=avc1.420033,mp4a.40.2'].map((type) => [type, MediaRecorder.isTypeSupported(type)]),
      mimeType: blob.type,
      lastExportMimeType: media.lastExportMimeType,
      initializationRecovery,
      bytes: blob.size,
      sourceDuration: media.duration,
      exportedDuration: reopened.duration,
      dimensions: [reopened.video.videoWidth, reopened.video.videoHeight],
      sourceCutDifference: difference(before, after),
      correctedCutDifference: difference(correctedBefore, correctedAfter),
      firstShotDifference: difference(before, correctedBefore),
      afterShotPixelChange: difference(after, correctedAfter),
      audioRms: Math.sqrt(squares / samples.length),
      audioDuration: decodedAudio.duration,
      exportWallSeconds,
      restoredTime,
      base64: await base64(blob),
    };
    media.destroy();
    reopened.destroy();
    const moving = new MediaSession();
    const movingBlob = await (await fetch('/motion.mp4')).blob();
    await moving.openFile(new File([movingBlob], 'moving.mp4', { type: 'video/mp4' }));
    moving.cutSeconds = 1;
    moving.setYaw(90);
    moving.addCut();
    moving.setYaw(-90);
    const sampleTimes = [0.5, 1.5, 2.5];
    const expectedFrames = [];
    const sourceFrames = [];
    for (const time of sampleTimes) {
      expectedFrames.push(await frame(moving, time, moving.yawAt(time)));
      sourceFrames.push(await frame(moving, time));
    }
    const pendingExport = moving.exportMp4();
    const recordingLocks = [];
    for (const [name, edit] of [
      ['yaw', () => moving.setYaw(12)],
      ['cut', () => { moving.cutSeconds = 2.1; }],
      ['selection', () => moving.selectCut(0)],
      ['add', () => moving.addCut()],
      ['remove', () => moving.removeCut()],
      ['seek', () => moving.seek(0.2)],
      ['play', () => moving.playCut()],
      ['play-from', () => moving.playFrom(0)],
      ['demo', () => moving.openDemo()],
      ['file', () => moving.openFile(new File([movingBlob], 'other.mp4', { type: 'video/mp4' }))],
      ['export', () => moving.exportMp4()],
    ]) {
      try { await edit(); throw new Error(`${name} edited during export`); }
      catch (error) {
        if (error.message !== 'Wait for the MP4 export to finish.') throw error;
        recordingLocks.push(name);
      }
    }
    const movingExport = await pendingExport;
    const movingReopened = new MediaSession();
    await movingReopened.openFile(new File([movingExport], 'moving-corrected.mp4', { type: movingExport.type }));
    measurements.movingCuts = moving.cuts;
    measurements.recordingLocks = recordingLocks;
    measurements.movingSegmentPixelDifferences = [];
    measurements.movingYawPixelChanges = [];
    measurements.movingMotionDifferences = [];
    for (let i = 0; i < sampleTimes.length; i++) {
      const reopenedFrame = await frame(movingReopened, sampleTimes[i]);
      measurements.movingSegmentPixelDifferences.push(difference(expectedFrames[i], reopenedFrame));
      measurements.movingYawPixelChanges.push(difference(sourceFrames[i], reopenedFrame));
      measurements.movingMotionDifferences.push(difference(await frame(movingReopened, i + 0.15), await frame(movingReopened, i + 0.8)));
    }
    measurements.movingDuration = movingReopened.duration;
    measurements.movingBase64 = await base64(movingExport);
    const movingAudio = await audio.decodeAudioData(await movingExport.arrayBuffer());
    const movingSamples = movingAudio.getChannelData(0);
    measurements.movingAudioRms = Math.sqrt(movingSamples.reduce((sum, sample) => sum + sample * sample, 0) / movingSamples.length);
    measurements.movingAudioDuration = movingAudio.duration;
    // Reusing an imported session starts a fresh one-cut film.
    await moving.openFile(new File([movingBlob], 'moving-again.mp4', { type: 'video/mp4' }));
    measurements.reimportedCuts = moving.cuts;
    moving.destroy();
    movingReopened.destroy();
    await audio.close();
    return measurements;
  }, metadata);
  const { base64, movingBase64, ...measurements } = result;
  measurements.timelineChecks = timelineChecks;
  await writeFile(path.join(out, 'orbit-corrected.mp4'), Buffer.from(base64, 'base64'));
  await writeFile(path.join(out, 'moving-corrected.mp4'), Buffer.from(movingBase64, 'base64'));
  measurements.ffprobe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,avg_frame_rate,r_frame_rate,duration,start_time',
    '-show_entries', 'format=duration', '-of', 'json', path.join(out, 'orbit-corrected.mp4'),
  ], { encoding: 'utf8' }));
  await writeFile(path.join(out, 'media-smoke.json'), JSON.stringify(measurements, null, 2) + '\n');
  console.log(JSON.stringify(measurements, null, 2));
  assert.ok(result.mimeType.startsWith('video/mp4'));
  assert.equal(result.lastExportMimeType, result.mimeType);
  assert.deepEqual(result.initializationRecovery, ['AudioContext', 'MediaRecorder']);
  assert.deepEqual(result.dimensions, [metadata.width, metadata.height]);
  assert.ok(Math.abs(result.exportedDuration - metadata.duration_seconds) < 0.75, 'MP4 retains playback duration');
  assert.ok(result.exportWallSeconds > metadata.duration_seconds - 0.75, 'native export plays the timeline in real time');
  assert.ok(result.sourceCutDifference > 3, 'synthetic source has a measurable cut');
  assert.ok(result.correctedCutDifference < result.sourceCutDifference * 0.45, 'negative yaw aligns second-shot pixels');
  assert.ok(result.firstShotDifference < 4, 'first-shot pixels stay in place');
  assert.ok(result.afterShotPixelChange > 3, 'export changes second-shot pixels');
  assert.ok(result.audioRms > 0.001, 'export retains audible source samples');
  assert.ok(Math.abs(result.audioDuration - metadata.duration_seconds) < 0.75, 'soundtrack retains duration');
  assert.ok(Math.abs(result.restoredTime - 9) < 0.05, 'export restores preview time');
  assert.deepEqual(result.movingCuts, [{ seconds: 1, yawDegrees: 90 }, { seconds: 2, yawDegrees: -90 }]);
  assert.deepEqual(result.recordingLocks, ['yaw', 'cut', 'selection', 'add', 'remove', 'seek', 'play', 'play-from', 'demo', 'file', 'export']);
  assert.deepEqual(result.reimportedCuts, [{ seconds: 1.5, yawDegrees: 0 }], 'import resets to a single uncorrected cut');
  for (const [index, error] of result.movingSegmentPixelDifferences.entries()) {
    assert.ok(error < 12, `shot ${index + 1} pixels match its absolute yaw (error ${error.toFixed(2)})`);
    if (index > 0) assert.ok(result.movingYawPixelChanges[index] > error + 20, `shot ${index + 1} is actually rotated`);
    assert.ok(result.movingMotionDifferences[index] > 5, `shot ${index + 1} retains moving frames`);
  }
  assert.ok(Math.abs(result.movingDuration - 3) < 0.5, 'moving three-shot clip retains its timeline');
  assert.ok(result.movingAudioRms > 0.001, 'three-shot export retains audible samples');
  assert.ok(Math.abs(result.movingAudioDuration - 3) < 0.5, 'three-shot soundtrack retains duration');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
