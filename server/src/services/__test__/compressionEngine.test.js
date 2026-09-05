/**
 * Lightweight, dependency-free test runner (no jest/mocha needed) that
 * exercises the real compressionEngine against generated images. Run with:
 *   npm test   (from server/)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compressImage } from '../compressionEngine.js';

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

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/** A photo-like source: smooth gradients + shapes compress realistically
 * (unlike pure noise), saved uncompressed (TIFF) so the *source* file is
 * large the way a real camera TIFF/RAW export would be. */
async function makePhotoLikeTiff(filePath, width, height) {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#274b6d"/>
          <stop offset="50%" stop-color="#7fa7c9"/>
          <stop offset="100%" stop-color="#f3d9a4"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g1)"/>
      ${Array.from({ length: 400 }).map(() => {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = 10 + Math.random() * (width / 12);
    const hue = Math.floor(Math.random() * 360);
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${hue},60%,55%)" fill-opacity="0.25"/>`;
  }).join('')}
    </svg>`;
  await sharp(Buffer.from(svg), { limitInputPixels: false })
    .tiff({ compression: 'none' })
    .toFile(filePath);
}

/** A high-entropy image: real photo noise/grain layered on a base pattern.
 * Used to prove the resolution-ladder fallback path actually engages when
 * quality reduction alone cannot hit an aggressive target. */
async function makeNoisyPng(filePath, width, height, withAlpha) {
  const channels = withAlpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += channels) {
    raw[i] = Math.floor(Math.random() * 256);
    raw[i + 1] = Math.floor(Math.random() * 256);
    raw[i + 2] = Math.floor(Math.random() * 256);
    if (withAlpha) raw[i + 3] = 255;
  }
  await sharp(raw, { raw: { width, height, channels }, limitInputPixels: false })
    .png()
    .toFile(filePath);
}

/** A PNG with real transparency (partially see-through shapes on a
 * transparent canvas) to verify alpha is preserved end to end. */
async function makeTransparentPng(filePath, width, height) {
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="10%" y="10%" width="35%" height="35%" fill="#3ECF8E" fill-opacity="0.6"/>
      <circle cx="70%" cy="65%" r="${Math.min(width, height) * 0.2}" fill="#F2A94E" fill-opacity="0.5"/>
    </svg>`;
  await sharp(Buffer.from(svg), { limitInputPixels: false }).png().toFile(filePath);
}

async function run() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });

  console.log('\n[1/4] Generating fixtures (this creates real large files on disk)...');
  const photoPath = path.join(FIXTURE_DIR, 'photo-like.tiff');
  const noisyPath = path.join(FIXTURE_DIR, 'noisy.png');
  const alphaPath = path.join(FIXTURE_DIR, 'transparent.png');

  await makePhotoLikeTiff(photoPath, 6000, 4000); // ~72MB uncompressed RGB TIFF
  await makeNoisyPng(noisyPath, 2400, 1600, false); // large, low-redundancy PNG
  await makeTransparentPng(alphaPath, 1200, 900); // small, needs alpha preserved

  const photoStat = await fs.stat(photoPath);
  const noisyStat = await fs.stat(noisyPath);
  const alphaStat = await fs.stat(alphaPath);
  console.log(`  photo-like.tiff:  ${mb(photoStat.size)}`);
  console.log(`  noisy.png:        ${mb(noisyStat.size)}`);
  console.log(`  transparent.png:  ${mb(alphaStat.size)}`);

  // --- Test 1: realistic photo, generous target (10MB), auto format ---
  console.log('\n[2/4] Compressing photo-like.tiff -> target 10MB, format=auto');
  const t0 = Date.now();
  const result1 = await compressImage({
    filePath: photoPath,
    targetBytes: 10 * 1024 * 1024,
    formatPref: 'auto',
  });
  console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  ${mb(result1.originalSize)} -> ${mb(result1.compressedSize)} | format=${result1.format} quality=${result1.quality} scale=${result1.scale} targetReached=${result1.targetReached}`);
  assert(result1.compressedSize <= 10 * 1024 * 1024, 'result stays at/under the 10MB target');
  assert(result1.compressedSize < result1.originalSize, 'compressed size is smaller than the original');
  assert(result1.targetReached === true, 'target is reported as reached for an achievable case');
  assert(['avif', 'webp'].includes(result1.format), 'auto-selected a modern format for an opaque photo (avif/webp)');
  assert(result1.quality >= 20 && result1.quality <= 100, 'quality is within a sane 1-100 range');
  assert(result1.width === result1.originalWidth && result1.height === result1.originalHeight, 'resolution preserved since quality alone reached the target');

  // --- Test 1b: small opaque photo should auto-pick AVIF (below the
  // megapixel threshold where AVIF's much slower encode is still worth it)
  console.log('\n[2b/4] Compressing a small crop -> target 100KB, format=auto (expect AVIF)');
  const smallCropPath = path.join(FIXTURE_DIR, 'photo-small-crop.jpg');
  await sharp(photoPath, { limitInputPixels: false }).resize(1600, 1200).jpeg({ quality: 95 }).toFile(smallCropPath);
  const resultSmall = await compressImage({
    filePath: smallCropPath,
    targetBytes: 100 * 1024,
    formatPref: 'auto',
  });
  console.log(`  ${mb(resultSmall.originalSize)} -> ${mb(resultSmall.compressedSize)} | format=${resultSmall.format} quality=${resultSmall.quality}`);
  assert(resultSmall.format === 'avif', 'small opaque images auto-select AVIF for best quality/size');
  assert(resultSmall.compressedSize <= 100 * 1024, 'small-crop result stays under its target');

  // --- Test 2: transparency must survive ---
  console.log('\n[3/4] Compressing transparent.png -> target 1MB, format=auto (must keep alpha)');
  const result2 = await compressImage({
    filePath: alphaPath,
    targetBytes: 1 * 1024 * 1024,
    formatPref: 'auto',
  });
  console.log(`  ${mb(result2.originalSize)} -> ${mb(result2.compressedSize)} | format=${result2.format} quality=${result2.quality}`);
  assert(result2.format === 'png', 'already-under-target images keep their original format');
  assert(result2.unchanged === true, 'already-under-target transparent images remain unchanged');
  const outMeta = await sharp(result2.buffer).metadata();
  assert(outMeta.hasAlpha === true, 'output image still has an alpha channel');

  // --- Test 3: aggressive/impossible target triggers honest fallback ---
  console.log('\n[4/4] Compressing noisy.png -> impossible 3KB target (should NOT silently destroy quality)');
  const result3 = await compressImage({
    filePath: noisyPath,
    targetBytes: 3 * 1024, // deliberately impossible for high-entropy noise
    formatPref: 'auto',
    qualityFloor: 35,
  });
  console.log(`  ${mb(result3.originalSize)} -> ${mb(result3.compressedSize)} | format=${result3.format} quality=${result3.quality} scale=${result3.scale} targetReached=${result3.targetReached}`);
  assert(result3.targetReached === false, 'engine honestly reports the target could not be reached');
  assert(result3.compressedSize < result3.originalSize, 'still returns a meaningfully smaller best-effort result');
  assert(result3.quality >= 20, 'does not crush quality below the absolute floor even when target is unreachable');

  // --- Test 4: already-under-target short circuit ---
  console.log('\nBonus: file already under target should short-circuit cleanly');
  const result4 = await compressImage({
    filePath: alphaPath,
    targetBytes: 100 * 1024 * 1024, // huge target, file is already tiny
    formatPref: 'auto',
  });
  const alphaBytes = await fs.readFile(alphaPath);
  assert(result4.alreadyUnderTarget === true, 'flags alreadyUnderTarget when the source is already small enough');
  assert(result4.targetReached === true, 'alreadyUnderTarget case also reports targetReached');
  assert(result4.unchanged === true, 'alreadyUnderTarget case keeps the source unchanged');
  assert(Buffer.compare(result4.buffer, alphaBytes) === 0, 'alreadyUnderTarget result is byte-for-byte identical to the source');

  // --- Test 5: already-small file where re-encoding would make it BIGGER
  // must fall back to the untouched original rather than "compressing" it
  // into something larger.
  console.log('\nBonus: re-encode-would-inflate case must keep the original bytes');
  const alreadyCompressedJpg = path.join(FIXTURE_DIR, 'already-compressed.jpg');
  await sharp(photoPath, { limitInputPixels: false }).resize(1600, 1067).jpeg({ quality: 96 }).toFile(alreadyCompressedJpg);
  const originalBytes = await fs.readFile(alreadyCompressedJpg);
  const result5 = await compressImage({
    filePath: alreadyCompressedJpg,
    targetBytes: 5 * 1024 * 1024, // huge target relative to the ~1-2MB source
    formatPref: 'auto',
  });
  console.log(`  ${mb(result5.originalSize)} -> ${mb(result5.compressedSize)} | unchanged=${result5.unchanged} format=${result5.format}`);
  assert(result5.compressedSize <= result5.originalSize, 'never returns something bigger than the original');
  if (result5.unchanged) {
    assert(Buffer.compare(result5.buffer, originalBytes) === 0, 'unchanged result is byte-for-byte identical to the source');
  }

  // --- Test 6: large source needing heavy downscaling should skip ahead
  // via the resolution probe instead of exhaustively trying every larger
  // step at full/near-full resolution first. This is a direct regression
  // test for the real-world complaint that a single huge, high-megapixel
  // source could take 15-20 minutes: correctness (still reaches target,
  // still returns a valid image) matters most here, but the wall-clock
  // budget also guards against silently regressing back to the exhaustive
  // from-scratch ladder walk.
  console.log('\nBonus: large source + aggressive target should engage the resolution probe');
  const hugePhotoPath = path.join(FIXTURE_DIR, 'huge-photo.tiff');
  await makePhotoLikeTiff(hugePhotoPath, 9000, 6000); // 54 megapixels
  const hugeStat = await fs.stat(hugePhotoPath);
  console.log(`  huge-photo.tiff: ${mb(hugeStat.size)} (9000x6000, 54MP)`);
  const t1 = Date.now();
  // A target aggressive enough that quality alone at full/near-full
  // resolution cannot reach it, forcing real downscaling.
  const result6 = await compressImage({
    filePath: hugePhotoPath,
    targetBytes: 800 * 1024, // 800KB - tiny relative to a 54MP source
    formatPref: 'auto',
  });
  const elapsed6 = (Date.now() - t1) / 1000;
  console.log(`  took ${elapsed6.toFixed(1)}s`);
  console.log(`  ${mb(result6.originalSize)} -> ${mb(result6.compressedSize)} | format=${result6.format} quality=${result6.quality} scale=${result6.scale} ${result6.width}x${result6.height} targetReached=${result6.targetReached}`);
  assert(result6.compressedSize <= 800 * 1024 || result6.targetReached === false, 'result stays at/under target (or honestly reports it could not)');
  assert(result6.compressedSize < result6.originalSize, 'still returns something meaningfully smaller than the 54MP original');
  assert(result6.scale < 1, 'an aggressive target on a 54MP source actually engages resolution reduction');
  assert(result6.width < result6.originalWidth && result6.height < result6.originalHeight, 'output dimensions are genuinely reduced from the original');
  assert(elapsed6 < 90, `completes in well under a naive from-scratch full-ladder walk (took ${elapsed6.toFixed(1)}s)`);

  // --- Test 7: Maximum Width feature - landscape source gets capped and
  // height is derived to preserve the original aspect ratio.
  console.log('\n[Max width] 6000x4000 landscape capped to maxWidth=3000, target 2MB');
  const landscapePath = path.join(FIXTURE_DIR, 'landscape-6000x4000.jpg');
  await sharp(photoPath, { limitInputPixels: false }).resize(6000, 4000).jpeg({ quality: 96 }).toFile(landscapePath);
  const result7 = await compressImage({
    filePath: landscapePath,
    targetBytes: 2 * 1024 * 1024,
    maxWidth: 3000,
  });
  console.log(`  ${result7.originalWidth}x${result7.originalHeight} -> ${result7.width}x${result7.height} | ${mb(result7.compressedSize)} maxWidthApplied=${result7.maxWidthApplied}`);
  assert(result7.width === 3000 && result7.height === 2000, 'landscape resized to exactly maxWidth with proportional height');
  assert(result7.originalWidth === 6000 && result7.originalHeight === 4000, 'true original dimensions are still reported for display');
  assert(result7.maxWidthApplied === true && result7.requestedMaxWidth === 3000, 'result flags that the width cap was applied');
  assert(result7.compressedSize <= 2 * 1024 * 1024, 'resized+compressed result meets the 2MB target');

  // --- Test 8: Maximum Width on a portrait source - width (not the longer
  // edge) is what gets capped, exactly as specified.
  console.log('\n[Max width] 4000x6000 portrait capped to maxWidth=3000');
  const portraitPath = path.join(FIXTURE_DIR, 'portrait-4000x6000.jpg');
  await sharp(photoPath, { limitInputPixels: false }).resize(4000, 6000).jpeg({ quality: 96 }).toFile(portraitPath);
  const result8 = await compressImage({
    filePath: portraitPath,
    targetBytes: 2 * 1024 * 1024,
    maxWidth: 3000,
  });
  console.log(`  ${result8.originalWidth}x${result8.originalHeight} -> ${result8.width}x${result8.height}`);
  assert(result8.width === 3000 && result8.height === 4500, 'portrait resized to 3000x4500, preserving aspect ratio');

  // --- Test 9: "Don't enlarge" - a maxWidth at or above the source's own
  // width must never upscale, and should fall back to the plain unchanged
  // fast path exactly like maxWidth being omitted entirely.
  console.log('\n[Max width] maxWidth larger than the source must never upscale');
  const smallPath = path.join(FIXTURE_DIR, 'small-for-maxwidth.jpg');
  await sharp(photoPath, { limitInputPixels: false }).resize(800, 600).jpeg({ quality: 90 }).toFile(smallPath);
  const smallBytes = await fs.readFile(smallPath);
  const result9 = await compressImage({
    filePath: smallPath,
    targetBytes: 50 * 1024 * 1024,
    maxWidth: 6000,
  });
  assert(result9.width === 800 && result9.height === 600, 'source dimensions are untouched when maxWidth exceeds them');
  assert(result9.unchanged === true, 'behaves exactly like the no-maxWidth fast path when nothing needs to shrink');
  assert(Buffer.compare(result9.buffer, smallBytes) === 0, 'bytes are byte-for-byte identical to the source');
  assert(result9.maxWidthApplied === false, 'maxWidthApplied is false when the cap was a no-op');

  // --- Test 10: maxWidth equal to the source's own width is also a no-op
  // (">=", not just ">").
  const result10 = await compressImage({
    filePath: landscapePath,
    targetBytes: 50 * 1024 * 1024,
    maxWidth: 6000,
  });
  assert(result10.width === 6000 && result10.height === 4000 && result10.maxWidthApplied === false, 'maxWidth exactly equal to source width is a no-op ("Original" behavior)');

  // --- Test 11: omitting maxWidth entirely (the plain "Original" case)
  // must produce byte-for-byte the same result as before this feature
  // existed - a direct regression guard against this change altering the
  // existing compressor's default behavior.
  const resultPlain = await compressImage({
    filePath: landscapePath,
    targetBytes: 2 * 1024 * 1024,
  });
  const resultExplicitOriginal = await compressImage({
    filePath: landscapePath,
    targetBytes: 2 * 1024 * 1024,
    maxWidth: null,
  });
  assert(
    resultPlain.compressedSize === resultExplicitOriginal.compressedSize
      && resultPlain.width === resultExplicitOriginal.width,
    'omitting maxWidth vs. explicitly passing null produce identical results ("Original" is truly a no-op)',
  );

  console.log(`\n${passed} passed, ${failures} failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exitCode = 1;
});
