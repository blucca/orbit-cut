import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A recorder alongside the real renderer; application state is untouched.
export default async function ({ frame, workspaceRoot }) {
  const action = process.env.ORBIT_RECORD_ACTION ?? 'start';
  const out = process.env.ORBIT_DEMO_OUTPUT ?? path.join(workspaceRoot, 'temp', 'demo');
  await mkdir(out, { recursive: true });
  if (action === 'start') {
    return await frame.evaluate(() => {
      if (window.__orbitCapture) throw new Error('A capture already exists');
      const candidates = [...document.querySelectorAll('canvas')]
        .filter(c => c.width && c.height && c.getBoundingClientRect().width > 0)
        .sort((a, b) => b.width * b.height - a.width * a.height);
      const canvas = candidates[0];
      if (!canvas) throw new Error('Visible runtime canvas missing');
      const stream = canvas.captureStream(15);
      const mimeType = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('VP8 capture unavailable');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4000000 });
      const capture = { recorder, stream, chunks: [], startedEpochMs: Date.now(),
        width: canvas.width, height: canvas.height, source: 'Live IWSDK runtime WebGL canvas; IWER hand input' };
      recorder.ondataavailable = event => { if (event.data.size) capture.chunks.push(event.data); };
      window.__orbitCapture = capture;
      recorder.start(1000);
      return { startedEpochMs: capture.startedEpochMs, width: canvas.width, height: canvas.height,
        mimeType, source: capture.source, canvasCount: candidates.length };
    });
  }
  const summary = await frame.evaluate(async (action) => {
    let blob;
    if (action === 'stop') {
      const capture = window.__orbitCapture;
      if (!capture) throw new Error('Capture missing');
      await new Promise((resolve, reject) => {
        capture.recorder.onstop = resolve;
        capture.recorder.onerror = reject;
        capture.recorder.stop();
      });
      capture.stream.getTracks().forEach(track => track.stop());
      blob = new Blob(capture.chunks, { type: capture.recorder.mimeType });
      capture.chunks = [];
    } else if (action === 'save-export') {
      const link = document.querySelector('#download');
      if (!link?.href.startsWith('blob:')) throw new Error('Actual application export missing');
      blob = await (await fetch(link.href)).blob();
    } else {
      throw new Error(`Unknown recording action: ${action}`);
    }
    window.__orbitCaptureBlob = blob;
    return { bytes: blob.size, mimeType: blob.type, stoppedEpochMs: Date.now() };
  }, action);
  if (!summary.bytes) throw new Error('Recorded file is empty');
  // Transfer bounded chunks instead of returning video bytes in the CLI envelope.
  const buffers = [];
  for (let offset = 0; offset < summary.bytes; offset += 262144) {
    const bytes = await frame.evaluate(async offset => Array.from(new Uint8Array(
      await window.__orbitCaptureBlob.slice(offset, offset + 262144).arrayBuffer())), offset);
    buffers.push(Buffer.from(bytes));
  }
  const filename = action === 'stop' ? 'orbit-raw.webm' : 'orbit-actual-xr-export.mp4';
  await writeFile(path.join(out, filename), Buffer.concat(buffers));
  await frame.evaluate(() => { delete window.__orbitCaptureBlob; });
  return { ...summary, filename };
}
