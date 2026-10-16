/** Native browser MP4 import → pixel yaw export → reopen, without IWSDK or Vite.
 * Requires FFmpeg for the small moving synthetic fixture.
 * npm ci && npx playwright install chromium
 * ORBIT_MEDIA_OUTPUT=/path/to/workspace/temp/media node scripts/media-smoke.mjs
 * CHROMIUM_PATH=/usr/bin/chromium optionally uses a system browser.
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
const out = path.resolve(process.env.ORBIT_MEDIA_OUTPUT ?? path.join(root, 'temp/media-smoke'));
await mkdir(out, { recursive: true });
const motionPath = path.join(out, 'moving-source.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=12:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1',
  '-c:a', 'aac', '-shortest', motionPath,
]);
const motionFixture = await readFile(motionPath);
const source = await readFile(path.join(root, 'src/media.ts'), 'utf8');
const module = ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL', "'/'"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
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
    const frame = async (session, time) => {
      await session.seek(time);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(session.video, 0, 0, 256, 128);
      return context.getImageData(0, 0, 256, 128).data;
    };
    const difference = (left, right) => {
      let sum = 0;
      for (let i = 0; i < left.length; i++) if (i % 4 !== 3) sum += Math.abs(left[i] - right[i]);
      return sum / (left.length * 0.75);
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
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
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
      base64: btoa(binary),
    };
    media.destroy();
    reopened.destroy();
    const moving = new MediaSession();
    const movingBlob = await (await fetch('/motion.mp4')).blob();
    await moving.openFile(new File([movingBlob], 'moving.mp4', { type: 'video/mp4' }));
    moving.setYaw(90);
    const movingExport = await moving.exportMp4();
    const movingReopened = new MediaSession();
    await movingReopened.openFile(new File([movingExport], 'moving-corrected.mp4', { type: movingExport.type }));
    measurements.movingFirstShotDifference = difference(await frame(movingReopened, 0.15), await frame(movingReopened, 0.8));
    measurements.movingSecondShotDifference = difference(await frame(movingReopened, 1.15), await frame(movingReopened, 1.8));
    measurements.movingDuration = movingReopened.duration;
    moving.destroy();
    movingReopened.destroy();
    await audio.close();
    return measurements;
  }, metadata);
  const { base64, ...measurements } = result;
  await writeFile(path.join(out, 'orbit-corrected.mp4'), Buffer.from(base64, 'base64'));
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
  assert.ok(result.movingFirstShotDifference > 5, 'first shot retains moving frames');
  assert.ok(result.movingSecondShotDifference > 5, 'rotated second shot retains moving frames');
  assert.ok(Math.abs(result.movingDuration - 2) < 0.5, 'moving clip retains its timeline');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
