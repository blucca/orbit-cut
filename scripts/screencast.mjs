import { existsSync, openSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright';

// A read-only compositor observer: canvas.captureStream sees a cleared XR buffer.
const out = process.env.ORBIT_DEMO_OUTPUT;
const status = JSON.parse(await readFile(path.join(out, 'dev-status.json'), 'utf8'));
const automation = status.data.state.session.browserAutomation;
const browser = await chromium.connectOverCDP(automation.endpoint);
let cdp;
let page;
for (const candidate of browser.contexts().flatMap(context => context.pages())) {
  const session = await candidate.context().newCDPSession(candidate);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  if (targetInfo.targetId === automation.targetId) {
    cdp = session;
    page = candidate;
    break;
  }
  await session.detach();
}
if (!cdp) throw new Error('Exact managed browser target is missing');
const clip = JSON.parse(await readFile(path.join(out, 'capture-prepare.json'), 'utf8')).data.result.clip;
const crop = [clip.width, clip.height, clip.x, clip.y].map(Math.floor);
const encoder = spawn('ffmpeg', ['-hide_banner', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg',
  '-framerate', '15', '-i', '-', '-an', '-vf',
  `crop=${crop.join(':')},scale=1000:760:force_original_aspect_ratio=decrease,pad=1000:760:(ow-iw)/2:(oh-ih)/2`,
  '-r', '15', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', path.join(out, 'orbit-raw.mp4')],
  { stdio: ['pipe', 'ignore', openSync(path.join(out, 'screencast-ffmpeg.log'), 'w')] });
const encoded = once(encoder, 'exit');
let latest;
let received = 0;
let written = 0;
let startedEpochMs;
let stop = false;
process.on('SIGTERM', () => { stop = true; });
encoder.stdin.on('error', error => { console.error(error); stop = true; });
cdp.on('Page.screencastFrame', event => {
  latest = Buffer.from(event.data, 'base64');
  received++;
  cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
});
try {
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
  const readyDeadline = Date.now() + 15000;
  while (!latest && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (!latest) throw new Error('Compositor produced no frames');
  startedEpochMs = Date.now();
  await writeFile(path.join(out, 'capture-first.jpg'), latest);
  await writeFile(path.join(out, 'capture-start.json'), JSON.stringify({ ok: true, data: { result: {
    startedEpochMs, width: 1000, height: 760, clip,
    source: 'Live Chrome compositor; runtime iframe crop; IWER native hand input',
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    mimeType: 'video/mp4;codecs=avc1',
  } } }, null, 2));
  // Keep wall-clock timing while static compositor frames are naturally sparse.
  while (!stop && !existsSync(path.join(out, 'capture-stop.request')) && Date.now() - startedEpochMs < 180000) {
    const targetFrames = Math.floor((Date.now() - startedEpochMs) * 15 / 1000) + 1;
    while (written < targetFrames) {
      if (!encoder.stdin.write(latest)) await once(encoder.stdin, 'drain');
      written++;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  encoder.stdin.end();
  const [code] = await encoded;
  await writeFile(path.join(out, 'capture-stop.json'), JSON.stringify({ ok: code === 0,
    received, written, seconds: written / 15, startedEpochMs, stoppedEpochMs: Date.now(),
    filename: 'orbit-raw.mp4' }, null, 2));
  await cdp.detach();
  // connectOverCDP.close disconnects this observer, leaving the SDK-owned browser open.
  await browser.close();
  if (code !== 0) throw new Error(`Screencast encoding failed: ${code}`);
}
