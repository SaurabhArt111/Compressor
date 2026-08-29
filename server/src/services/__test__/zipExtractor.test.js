/**
 * Lightweight, dependency-free test runner (matches compressionEngine.test.js)
 * for the ZIP-upload auto-extract feature. Run with:
 *   npm run test:zip   (from server/)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { extractZipIntoJob } from '../zipExtractor.js';
import { ALLOWED_EXTENSIONS } from '../../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', '..', '__test__', 'fixtures');

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

/** Builds a ZIP with a realistic mix: supported images in nested folders, an
 * unsupported text file, macOS/Windows junk, and a zip-slip traversal
 * attempt - all in one archive, the way a real "export as zip" tool might
 * hand us something messy without any malicious intent behind the junk. */
function buildFixtureZip(zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    output.on('close', resolve);
    output.on('error', reject);
    archive.pipe(output);

    archive.append(Buffer.from('pretend-jpeg-bytes-one'), { name: 'shoot/one.jpg' });
    archive.append(Buffer.from('pretend-png-bytes-two'), { name: 'shoot/edits/two.PNG' }); // uppercase ext
    archive.append(Buffer.from('a pdf'), { name: 'shoot/scan.pdf' });
    archive.append(Buffer.from('not an image'), { name: 'shoot/notes.txt' });
    archive.append(Buffer.from('mac resource fork junk'), { name: '__MACOSX/._one.jpg' });
    archive.append(Buffer.from('ds store junk'), { name: '.DS_Store' });
    archive.append(Buffer.from('traversal attempt'), { name: '../../../etc/passwd.jpg' });
    archive.append(Buffer.from('absolute-ish traversal'), { name: '/tmp/should-not-land-here.jpg' });

    archive.finalize();
  });
}

async function run() {
  await fsp.mkdir(FIXTURE_DIR, { recursive: true });
  const zipPath = path.join(FIXTURE_DIR, 'upload-fixture.zip');
  await buildFixtureZip(zipPath);
  console.log(`\nBuilt fixture ZIP: ${(fs.statSync(zipPath).size)} bytes`);

  const destRoot = path.join(FIXTURE_DIR, 'zip-extract-dest');
  await fsp.rm(destRoot, { recursive: true, force: true });
  await fsp.mkdir(destRoot, { recursive: true });

  console.log('\nExtracting ZIP into job upload directory...');
  const extracted = await extractZipIntoJob({
    zipPath,
    destRoot,
    baseName: 'my-archive',
    allowedExtensions: ALLOWED_EXTENSIONS,
  });
  console.log(`  extracted ${extracted.length} file(s):`);
  extracted.forEach((f) => console.log(`    ${f.relativePath} (${f.size}B)`));

  // 5, not 4: both traversal attempts *do* have a supported (.jpg) extension,
  // so they're legitimately extracted - just safely relocated inside
  // destRoot instead of being allowed to escape it. That relocation is
  // verified explicitly below.
  assert(extracted.length === 5, 'extracts the 5 supported, non-junk entries (including the neutralized traversal attempts)');
  assert(extracted.every((f) => f.relativePath.startsWith('my-archive/')), 'every extracted path is namespaced under the archive folder');
  assert(extracted.some((f) => f.relativePath === 'my-archive/shoot/one.jpg'), 'extracts a normally-nested supported file');
  assert(extracted.some((f) => f.relativePath.endsWith('two.PNG')), 'extracts a supported file with an uppercase extension');
  assert(extracted.some((f) => f.relativePath === 'my-archive/shoot/scan.pdf'), 'extracts a supported PDF alongside images');
  assert(!extracted.some((f) => f.relativePath.includes('notes.txt')), 'does not extract an unsupported .txt file');
  assert(!extracted.some((f) => f.relativePath.includes('__MACOSX')), 'skips __MACOSX junk');
  assert(!extracted.some((f) => f.relativePath.includes('.DS_Store')), 'skips .DS_Store junk');

  // The two traversal attempts must have been neutralized: sanitizeRelativePath
  // strips ".." segments and leading slashes, so both land safely *inside*
  // destRoot/my-archive rather than escaping it - and specifically not at
  // any path containing "etc" or landing outside destRoot entirely.
  for (const f of extracted) {
    const resolved = path.resolve(f.absolutePath);
    assert(resolved.startsWith(path.resolve(destRoot) + path.sep), `extracted file stays within destRoot: ${f.relativePath}`);
  }
  assert(!extracted.some((f) => path.resolve(f.absolutePath) === '/tmp/should-not-land-here.jpg'), 'an absolute-path entry cannot land outside destRoot');

  for (const f of extracted) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await fsp.access(f.absolutePath).then(() => true).catch(() => false);
    assert(exists, `file actually exists on disk: ${f.relativePath}`);
  }

  console.log(`\n${passed} passed, ${failures} failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exitCode = 1;
});
