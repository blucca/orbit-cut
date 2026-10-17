import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A recorder alongside the real renderer; application state is untouched.
export default async function ({ frame, page, workspaceRoot }) {
  const action = process.env.ORBIT_RECORD_ACTION ?? 'prepare';
  const out = process.env.ORBIT_DEMO_OUTPUT ?? path.join(workspaceRoot, 'temp', 'demo');
  await mkdir(out, { recursive: true });
  if (action === 'prepare') {
    const runtime = page.locator('[data-workspace-view-button="runtime"]');
    if (await runtime.count()) await runtime.click();
    await page.waitForTimeout(600);
    const element = await frame.frameElement();
    return { clip: await element.boundingBox() };
  }
  const summary = await frame.evaluate(async (action) => {
    let blob;
    if (action === 'save-export') {
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
  const filename = 'orbit-actual-xr-export.mp4';
  await writeFile(path.join(out, filename), Buffer.concat(buffers));
  await frame.evaluate(() => { delete window.__orbitCaptureBlob; });
  return { ...summary, filename };
}
