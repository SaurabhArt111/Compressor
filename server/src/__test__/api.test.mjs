/**
 * End-to-end integration test against the real HTTP API (no mocks): spins
 * up the actual Express server on a test port, uploads real generated
 * images (including a nested folder path and a transparent PNG), triggers
 * compression, polls job status, downloads individual files + a ZIP, and
 * checks the history endpoint. Also verifies mid-job cancellation.
 *
 * Run with: node src/__test__/api.test.mjs   (from server/, after `npm install`)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const TEST_PORT = 5799;
const BASE = `http://localhost:${TEST_PORT}`;
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  \u2713 ${msg}`); } else { failed += 1; console.error(`  \u2717 ${msg}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(300);
  }
  throw new Error('Server did not become healthy in time');
}

async function pollJob(jobId, { timeoutMs = 60000, targetStatuses = ['done', 'cancelled'] } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/api/compress/${jobId}`);
    const job = await res.json();
    if (targetStatuses.includes(job.status)) return job;
    // eslint-disable-next-line no-await-in-loop
    await sleep(400);
  }
  throw new Error(`Job ${jobId} did not reach [${targetStatuses}] in time`);
}

async function makeFixtures() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const jpgPath = path.join(FIXTURE_DIR, 'api-photo.jpg');
  const pngAlphaPath = path.join(FIXTURE_DIR, 'api-alpha.png');

  if (!fssync.existsSync(jpgPath)) {
    const svg = `<svg width="2400" height="1600" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1b2a3d"/><stop offset="100%" stop-color="#e8b45c"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      ${Array.from({ length: 150 }).map(() => `<circle cx="${(Math.random() * 2400).toFixed(0)}" cy="${(Math.random() * 1600).toFixed(0)}" r="${(10 + Math.random() * 150).toFixed(0)}" fill="hsl(${Math.floor(Math.random() * 360)},60%,55%)" fill-opacity="0.3"/>`).join('')}
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 97 }).toFile(jpgPath);
  }
  if (!fssync.existsSync(pngAlphaPath)) {
    const svg = `<svg width="900" height="700" xmlns="http://www.w3.org/2000/svg">
      <circle cx="450" cy="350" r="300" fill="#3ECF8E" fill-opacity="0.55"/>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(pngAlphaPath);
  }
  return { jpgPath, pngAlphaPath };
}

async function main() {
  console.log('Generating API test fixtures...');
  const { jpgPath, pngAlphaPath } = await makeFixtures();
  console.log(`  api-photo.jpg:  ${((await fs.stat(jpgPath)).size / 1024).toFixed(0)}KB`);
  console.log(`  api-alpha.png:  ${((await fs.stat(pngAlphaPath)).size / 1024).toFixed(0)}KB`);

  console.log('\nStarting server...');
  const server = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

  try {
    await waitForHealth();
    console.log('Server is healthy.\n');

    // ---------------- Happy path: upload -> compress -> download ----------------
    console.log('[1/3] Upload (with folder structure) + compress + download + zip + history');
    const form = new FormData();
    const jpgBlob = new Blob([await fs.readFile(jpgPath)], { type: 'image/jpeg' });
    const pngBlob = new Blob([await fs.readFile(pngAlphaPath)], { type: 'image/png' });
    form.append('files', jpgBlob, 'vacation/day1/beach.jpg');
    form.append('files', pngBlob, 'vacation/logo-alpha.png');

    const uploadRes = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
    assert(uploadRes.status === 201, `upload responds 201 (got ${uploadRes.status})`);
    const uploadJob = await uploadRes.json();
    assert(uploadJob.files.length === 2, 'both files registered on the job');
    const beachFile = uploadJob.files.find((f) => f.relativePath === 'vacation/day1/beach.jpg');
    assert(!!beachFile, 'nested folder path preserved exactly (vacation/day1/beach.jpg)');

    const compressRes = await fetch(`${BASE}/api/compress/${uploadJob.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMB: 1, format: 'auto', concurrency: 2 }),
    });
    assert(compressRes.status === 202, `compress start responds 202 (got ${compressRes.status})`);

    const finishedJob = await pollJob(uploadJob.id);
    assert(finishedJob.status === 'done', 'job reaches done status');
    assert(finishedJob.files.every((f) => f.status === 'done'), 'every file finished successfully');
    for (const f of finishedJob.files) {
      assert(!!f.result && f.result.compressedSize > 0, `${f.relativePath}: has a compression result`);
      assert(
        f.result.compressedSize <= f.result.originalSize,
        `${f.relativePath}: compressed size never exceeds original (${f.result.compressedSize} vs ${f.result.originalSize}, unchanged=${f.result.unchanged})`,
      );
    }
    const alphaResult = finishedJob.files.find((f) => f.relativePath.endsWith('logo-alpha.png')).result;
    assert(alphaResult.format === 'webp', 'transparent PNG auto-routed to WebP to keep alpha');

    // Individual download
    const fileId = finishedJob.files[0].id;
    const downloadRes = await fetch(`${BASE}/api/download/${uploadJob.id}/${fileId}`);
    assert(downloadRes.status === 200, 'individual file download responds 200');
    const downloadBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert(downloadBuf.length === finishedJob.files[0].result.compressedSize, 'downloaded bytes match reported compressed size');

    // Zip download - verify it actually contains both files with folder structure
    const zipRes = await fetch(`${BASE}/api/download/${uploadJob.id}/zip`);
    assert(zipRes.status === 200, 'zip download responds 200');
    assert(zipRes.headers.get('content-type') === 'application/zip', 'zip has correct content-type');
    const zipPath = path.join(FIXTURE_DIR, 'test-output.zip');
    await fs.writeFile(zipPath, Buffer.from(await zipRes.arrayBuffer()));
    const listing = execSync(`unzip -l "${zipPath}"`).toString();
    assert(listing.includes('vacation/day1/beach.') && listing.includes('vacation/logo-alpha.'), 'zip preserves nested folder structure for both files');

    // Thumbnail endpoint (used for before/after preview without shipping full images to the browser)
    const thumbRes = await fetch(`${BASE}/api/download/${uploadJob.id}/${fileId}/thumbnail/original`);
    assert(thumbRes.status === 200 && thumbRes.headers.get('content-type') === 'image/jpeg', 'original thumbnail endpoint returns a small JPEG');
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
    assert(thumbBuf.length < 200 * 1024, 'thumbnail is genuinely small (<200KB), not the full-size image');

    // History
    const historyRes = await fetch(`${BASE}/api/history`);
    const history = await historyRes.json();
    assert(history.some((h) => h.jobId === uploadJob.id), 'completed job appears in history');

    // ---------------- Cancellation ----------------
    console.log('\n[2/3] Cancel mid-job');
    const form2 = new FormData();
    // Make a few modestly large images so the job doesn't finish before we can cancel it.
    for (let i = 0; i < 4; i += 1) {
      const buf = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: Math.random() * 255, g: 100, b: 150 } } })
        .jpeg({ quality: 90 })
        .toBuffer();
      form2.append('files', new Blob([buf], { type: 'image/jpeg' }), `batch/img-${i}.jpg`);
    }
    const upload2 = await (await fetch(`${BASE}/api/upload`, { method: 'POST', body: form2 })).json();
    await fetch(`${BASE}/api/compress/${upload2.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMB: 0.05, format: 'auto', concurrency: 1 }),
    });
    await sleep(150); // let it actually start
    const cancelRes = await fetch(`${BASE}/api/compress/${upload2.id}/cancel`, { method: 'POST' });
    assert(cancelRes.status === 200, 'cancel endpoint responds 200');
    const cancelledJob = await pollJob(upload2.id);
    assert(cancelledJob.status === 'cancelled', 'job status becomes cancelled');
    assert(cancelledJob.files.some((f) => f.status === 'cancelled'), 'at least one queued/in-flight file marked cancelled, not stuck processing');

    // ---------------- Validation ----------------
    console.log('\n[3/3] Input validation');
    const badRes = await fetch(`${BASE}/api/compress/${uploadJob.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMB: -5 }),
    });
    assert(badRes.status === 400, 'negative targetMB rejected with 400');

    const missingJobRes = await fetch(`${BASE}/api/compress/does-not-exist`);
    assert(missingJobRes.status === 404, 'unknown job id returns 404');

    console.log(`\n${passed} passed, ${failed} failed.\n`);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('API test crashed:', err);
  process.exitCode = 1;
});
