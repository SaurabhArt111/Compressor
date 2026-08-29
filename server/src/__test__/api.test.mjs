/**
 * Black-box end-to-end test: spawns the real server (the same entrypoint
 * `npm start` runs) against a scratch uploads directory, then drives it
 * purely over HTTP exactly like the browser client does - upload a mix of
 * images/PDF/ZIP, start compression, poll for completion, download results,
 * check history, and exercise the file manager routes.
 *
 * Run with: npm run test:api   (from server/)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const SCRATCH_DIR = path.join(SERVER_DIR, '__test__', 'scratch-api');

let failures = 0;
let passed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${message}`);
  } else {
    failures += 1;
    console.error(`  \u2717 ${message}`);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 200));
    return tryOnce();
  };
  return tryOnce();
}

async function makeJpeg(sizeHint = 'small') {
  const dim = sizeHint === 'large' ? 2200 : 300;
  const svg = `<svg width="${dim}" height="${dim}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#3a6ea5"/>
    ${Array.from({ length: sizeHint === 'large' ? 400 : 20 }).map(() => {
    const cx = Math.random() * dim; const cy = Math.random() * dim; const r = 4 + Math.random() * (dim / 12);
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${Math.floor(Math.random() * 360)},70%,55%)" fill-opacity="0.5"/>`;
  }).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95, mozjpeg: true }).toBuffer();
}

async function makePdf() {
  const pdfDoc = await PDFDocument.create();
  const jpg = await makeJpeg('large');
  const embedded = await pdfDoc.embedJpg(jpg);
  const page = pdfDoc.addPage([600, 800]);
  page.drawImage(embedded, { x: 10, y: 200, width: 580, height: 560 });
  page.drawText('API test document', { x: 10, y: 780, size: 16 });
  return Buffer.from(await pdfDoc.save());
}

async function makeZip(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const { name, data } of entries) archive.append(data, { name });
    archive.finalize();
  });
}

async function run() {
  await fs.rm(SCRATCH_DIR, { recursive: true, force: true });
  const uploadRoot = path.join(SCRATCH_DIR, 'uploads');
  const historyFile = path.join(SCRATCH_DIR, 'data', 'history.json');
  await fs.mkdir(uploadRoot, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`\nStarting server on ${baseUrl} (scratch dir: ${SCRATCH_DIR})...`);
  const child = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      UPLOAD_ROOT: uploadRoot,
      HISTORY_FILE: historyFile,
      NODE_ENV: 'test',
      CORS_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    await waitForHealth(baseUrl, 15_000);
    console.log('  \u2713 server came up and /api/health responds');

    // --- 1. Upload: a small image, a large-ish image, a PDF, and a ZIP
    //     containing two more images plus a junk file. ---
    console.log('\nUploading a mixed batch (images + PDF + ZIP)...');
    const smallJpg = await makeJpeg('small');
    const largeJpg = await makeJpeg('large');
    const pdfBytes = await makePdf();
    const zipBytes = await makeZip([
      { name: 'batch/a.jpg', data: await makeJpeg('small') },
      { name: 'batch/nested/b.jpg', data: await makeJpeg('small') },
      { name: 'batch/readme.txt', data: Buffer.from('not compressible, should be skipped') },
    ]);

    const form = new FormData();
    form.append('files', new File([smallJpg], 'small.jpg', { type: 'image/jpeg' }));
    form.append('files', new File([largeJpg], 'large.jpg', { type: 'image/jpeg' }));
    form.append('files', new File([pdfBytes], 'document.pdf', { type: 'application/pdf' }));
    form.append('files', new File([zipBytes], 'photos.zip', { type: 'application/zip' }));

    const uploadRes = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
    const uploadBody = await uploadRes.json();
    assert(uploadRes.status === 201, `upload responds 201 (got ${uploadRes.status}: ${JSON.stringify(uploadBody).slice(0, 200)})`);
    assert(uploadBody.files?.length === 5, `job contains 5 files: 2 direct images + 1 pdf + 2 extracted from the zip (got ${uploadBody.files?.length})`);
    assert(uploadBody.files.some((f) => f.originalName === 'document.pdf' && f.kind === 'pdf'), 'the uploaded PDF is present and tagged kind=pdf');
    assert(uploadBody.files.some((f) => f.relativePath === 'photos/batch/a.jpg'), 'a zip-extracted file keeps its internal folder structure, namespaced under the archive name');
    assert(!uploadBody.files.some((f) => f.originalName === 'readme.txt'), 'the unsupported .txt file inside the zip was not queued');
    const jobId = uploadBody.id;

    // --- 2. Start compression with an aggressive-but-achievable target. ---
    console.log('\nStarting compression...');
    const startRes = await fetch(`${baseUrl}/api/compress/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMB: 0.15, format: 'auto', concurrency: 3 }),
    });
    assert(startRes.status === 202, `compression starts (got ${startRes.status})`);

    // Immediately try to delete the job's files while it's (most likely)
    // still processing - active jobs must be protected from deletion.
    const raceRes = await fetch(`${baseUrl}/api/files/${jobId}`, { method: 'DELETE' });
    if (raceRes.status === 409) {
      assert(true, 'deleting an active job\'s files is refused with 409 while it\'s still processing');
    } else {
      console.log(`  (job finished before the delete race could land - got ${raceRes.status}, not asserting this one)`);
    }

    console.log('\nPolling for completion...');
    let finalJob = null;
    const pollDeadline = Date.now() + 60_000;
    while (Date.now() < pollDeadline) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${baseUrl}/api/compress/${jobId}`);
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      if (body.status === 'done' || body.status === 'cancelled') { finalJob = body; break; }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(finalJob !== null, 'job reaches a finished state within the timeout');
    assert(finalJob?.status === 'done', `job status is "done" (got "${finalJob?.status}")`);

    const doneFiles = finalJob.files.filter((f) => f.status === 'done');
    assert(doneFiles.length === finalJob.files.length, `all ${finalJob.files.length} files completed successfully (${doneFiles.length} done)`);
    const pdfResult = finalJob.files.find((f) => f.kind === 'pdf');
    assert(pdfResult?.result?.imagesFound >= 1, 'the PDF result reports at least one embedded image found');
    assert(finalJob.durationMs !== null && finalJob.durationMs >= 0, 'job reports a non-negative elapsed duration');

    // --- 3. Download a single file and the whole batch as a ZIP. ---
    console.log('\nDownloading results...');
    const oneFile = doneFiles[0];
    const singleRes = await fetch(`${baseUrl}/api/download/${jobId}/${oneFile.id}`);
    assert(singleRes.status === 200, 'single-file download responds 200');
    const singleBuf = Buffer.from(await singleRes.arrayBuffer());
    assert(singleBuf.length === oneFile.result.compressedSize, 'downloaded single file size matches the reported compressed size');

    const zipRes = await fetch(`${baseUrl}/api/download/${jobId}/zip`);
    assert(zipRes.status === 200, 'batch zip download responds 200');
    assert((zipRes.headers.get('content-type') || '').includes('zip'), 'batch zip download has a zip content-type');

    // --- 4. History. ---
    console.log('\nChecking history...');
    const historyRes = await fetch(`${baseUrl}/api/history`);
    const historyBody = await historyRes.json();
    assert(Array.isArray(historyBody) && historyBody.some((r) => r.jobId === jobId), 'the finished job appears in history');

    const historyDeleteRes = await fetch(`${baseUrl}/api/history/${jobId}`, { method: 'DELETE' });
    assert(historyDeleteRes.status === 200, 'a single history record can be removed');
    const historyAfter = await (await fetch(`${baseUrl}/api/history`)).json();
    assert(!historyAfter.some((r) => r.jobId === jobId), 'the removed job no longer appears in history');

    // --- 5. File manager: browse, delete one item, then clear everything. ---
    console.log('\nChecking the file manager routes...');
    const treeRes = await fetch(`${baseUrl}/api/files/tree`);
    const tree = await treeRes.json();
    assert(treeRes.status === 200, 'file tree responds 200');
    const jobNode = tree.children.find((c) => c.name === jobId);
    assert(!!jobNode, 'the job shows up as a top-level folder in the uploads tree');
    assert(jobNode.active === false, 'a finished job is reported as not active (safe to delete)');
    assert(tree.totalSize > 0, 'reported total size is greater than zero');

    const smallFileEntry = finalJob.files.find((f) => f.originalName === 'small.jpg');
    const compressedPath = `${jobId}/compressed/${smallFileEntry.result.outputRelativePath}`;
    const originalPath = `${jobId}/original/${smallFileEntry.relativePath}`;

    function findNodePath(node, targetPath) {
      if (node.path === targetPath) return true;
      if (node.type === 'dir') return node.children.some((c) => findNodePath(c, targetPath));
      return false;
    }

    const deleteOneRes = await fetch(`${baseUrl}/api/files/${compressedPath}`, { method: 'DELETE' });
    assert(deleteOneRes.status === 200, 'deleting a single file inside a finished job succeeds');
    const treeAfterOne = await (await fetch(`${baseUrl}/api/files/tree`)).json();
    assert(
      !treeAfterOne.children.some((c) => findNodePath(c, compressedPath)),
      'the specific deleted (compressed) file no longer appears in the tree',
    );
    assert(
      treeAfterOne.children.some((c) => findNodePath(c, originalPath)),
      'the untouched original file is still present (only the compressed copy was deleted)',
    );

    const traversalRes = await fetch(`${baseUrl}/api/files/${encodeURIComponent('..')}${encodeURIComponent('/')}${encodeURIComponent('..')}`, { method: 'DELETE' });
    assert(traversalRes.status === 400, `a path-traversal delete attempt is rejected with 400, not executed (got ${traversalRes.status})`);
    const healthStillOk = await fetch(`${baseUrl}/api/health`);
    assert(healthStillOk.ok, 'server is still healthy after a traversal delete attempt');

    const clearRes = await fetch(`${baseUrl}/api/files/all`, { method: 'DELETE' });
    const clearBody = await clearRes.json();
    assert(clearRes.status === 200 && clearBody.cleared === true, 'clear-all succeeds');
    const treeAfterClear = await (await fetch(`${baseUrl}/api/files/tree`)).json();
    assert(treeAfterClear.children.length === 0, 'uploads tree is empty after clear-all');

    // --- 6. A too-small / bogus job id behaves like "not found", not a crash. ---
    const missingRes = await fetch(`${baseUrl}/api/compress/does-not-exist`);
    assert(missingRes.status === 404, 'fetching a nonexistent job returns 404');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (failures > 0) console.log(`\n--- server log tail ---\n${serverLog.split('\n').slice(-40).join('\n')}`);
  }

  console.log(`\n${passed} passed, ${failures} failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exitCode = 1;
});
