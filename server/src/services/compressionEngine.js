import sharp from 'sharp';
import fs from 'node:fs/promises';
import {
  QUALITY_FLOOR_DEFAULT,
  QUALITY_CEILING_DEFAULT,
  QUALITY_ABSOLUTE_FLOOR,
  RESOLUTION_LADDER,
} from '../config.js';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export const FORMAT_EXTENSION = {
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  png: 'png',
};

export const FORMAT_MIME = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};

/**
 * Decide which output format to use when the caller asked for "auto".
 *
 * - Transparency must survive -> WebP (lossy WebP keeps the alpha channel,
 *   unlike JPEG, and compresses far better than lossless PNG).
 * - Otherwise prefer AVIF, which beats JPEG/WebP at equal visual quality -
 *   but only on modest-sized images. Measured against this engine's own
 *   binary search: AVIF encoding (libaom) ran ~30x slower than WebP at the
 *   same resolution (24MP: ~55s vs ~2s for a single encode), and the search
 *   needs several encodes per image. Above the threshold below, that turns
 *   a several-second compression into several minutes, so large photos -
 *   exactly what this tool targets - fall back to WebP, which reaches
 *   similar visual quality per byte and stays fast enough for a responsive
 *   quality search.
 */
const AUTO_AVIF_MAX_MEGAPIXELS = 6;
const WEBP_MAX_DIMENSION = 16_383;

function pickAutoFormat(meta) {
  if (meta.hasAlpha) return 'webp';
  const megapixels = (meta.width * meta.height) / 1_000_000;
  return megapixels <= AUTO_AVIF_MAX_MEGAPIXELS ? 'avif' : 'webp';
}

function applyFormat(pipeline, format, quality) {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, mozjpeg: true });
    case 'webp':
      return pipeline.webp({ quality, effort: 4, alphaQuality: 100 });
    case 'avif':
      return pipeline.avif({ quality, effort: 3 });
    case 'png':
      return pipeline.png({ quality, effort: 6, palette: true, compressionLevel: 9 });
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

function buildPipeline(filePath, { width, height, originalWidth, originalHeight }) {
  // sequentialRead lets libvips stream the source top-to-bottom instead of
  // random-accessing it, which matters for very large JPEGs/TIFFs.
  // limitInputPixels is disabled because legitimate 300-500MB source photos
  // can exceed sharp's conservative default pixel-count safety cap.
  let pipeline = sharp(filePath, { sequentialRead: true, limitInputPixels: false });
  // Auto-orient based on EXIF, then strip the tag so viewers don't double-rotate.
  pipeline = pipeline.rotate();
  if (width && height && (width !== originalWidth || height !== originalHeight)) {
    pipeline = pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: true });
  }
  return pipeline;
}

async function encodeAttempt({ filePath, format, quality, width, height, originalWidth, originalHeight }) {
  let pipeline = buildPipeline(filePath, { width, height, originalWidth, originalHeight });
  pipeline = applyFormat(pipeline, format, quality);
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { buffer: data, info };
}

/**
 * Binary search for the highest quality setting whose encoded size is still
 * <= targetBytes at a fixed resolution. Sharp/libvips caches decode+resize
 * output internally, so repeated calls that only vary the final quality
 * knob are far cheaper than the first call.
 */
async function searchQuality({
  filePath, format, targetBytes, width, height, originalWidth, originalHeight,
  qMin, qMax, onIteration, isCancelled,
}) {
  let lo = qMin;
  let hi = qMax;
  let best = null; // highest-quality result that still meets the target
  let closest = null; // smallest-difference-from-target result, as a fallback
  let iterations = 0;
  const maxIterations = Math.max(1, Math.ceil(Math.log2(qMax - qMin + 2)));

  while (lo <= hi) {
    if (isCancelled()) throw new CancelledError();
    const mid = Math.floor((lo + hi) / 2);
    // eslint-disable-next-line no-await-in-loop
    const attempt = await encodeAttempt({ filePath, format, quality: mid, width, height, originalWidth, originalHeight });
    iterations += 1;
    onIteration?.(iterations, maxIterations);

    const size = attempt.buffer.length;
    if (!closest || Math.abs(size - targetBytes) < Math.abs(closest.buffer.length - targetBytes)) {
      closest = { ...attempt, quality: mid };
    }
    if (size <= targetBytes) {
      if (!best || mid > best.quality) best = { ...attempt, quality: mid };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { best, closest };
}

/**
 * Correct sharp's reported width/height for EXIF orientations that rotate
 * the image 90/270 degrees, so our resolution math (and the numbers shown
 * to the user) match what viewers actually display.
 */
function displayDimensions(meta) {
  const swapped = meta.orientation >= 5 && meta.orientation <= 8;
  return swapped
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

/**
 * Compress a single image to fit under targetBytes while maximizing visual
 * quality:
 *
 *   1. Fast path: if the source is already at or under the target, return
 *      its original bytes untouched.
 *   2. Binary-search quality at full resolution.
 *   3. If even the quality floor overshoots the target, step down a
 *      resolution ladder (100% -> 40%) and re-run the quality search at
 *      each step, stopping at the first step that succeeds.
 *   4. If nothing on the ladder reaches the target, fall back to the
 *      smallest result found and report targetReached: false rather than
 *      crushing quality/resolution further to force a match.
 */
export async function compressImage({
  filePath,
  targetBytes,
  formatPref = 'auto',
  qualityFloor = QUALITY_FLOOR_DEFAULT,
  qualityCeiling = QUALITY_CEILING_DEFAULT,
  onProgress,
  isCancelled = () => false,
}) {
  const meta = await sharp(filePath, { limitInputPixels: false }).metadata();
  const { width: originalWidth, height: originalHeight } = displayDimensions(meta);
  const originalSize = (await fs.stat(filePath)).size;

  let format = formatPref === 'auto' ? pickAutoFormat(meta) : formatPref;
  if (format === 'webp' && (meta.width > WEBP_MAX_DIMENSION || meta.height > WEBP_MAX_DIMENSION)) {
    format = meta.hasAlpha ? 'png' : 'jpeg';
  }
  // A format without alpha support would silently flatten transparency;
  // force a format that preserves it if the source needs it.
  if (meta.hasAlpha && (format === 'jpeg')) format = 'webp';

  let chosenResult = null;
  let chosenScale = 1;
  let targetReached = false;

  // The source already meets the target, so do not alter its encoding or metadata.
  if (originalSize <= targetBytes) {
    const originalBuffer = await fs.readFile(filePath);
    onProgress?.(1, 1, 1);
    return {
      buffer: originalBuffer,
      format: meta.format,
      quality: null,
      width: originalWidth,
      height: originalHeight,
      originalWidth,
      originalHeight,
      originalSize,
      compressedSize: originalSize,
      scale: 1,
      targetReached: true,
      alreadyUnderTarget: true,
      unchanged: true,
    };
  }

  for (let step = 0; step < RESOLUTION_LADDER.length; step += 1) {
    const scale = RESOLUTION_LADDER[step];
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));

    // eslint-disable-next-line no-await-in-loop
    const { best, closest } = await searchQuality({
      filePath, format, targetBytes,
      width, height, originalWidth, originalHeight,
      qMin: qualityFloor, qMax: qualityCeiling,
      onIteration: (i, total) => onProgress?.(scale, i, total, step, RESOLUTION_LADDER.length),
      isCancelled,
    });

    if (best) {
      chosenResult = best;
      chosenScale = scale;
      targetReached = true;
      break;
    }
    if (!chosenResult || closest.buffer.length < chosenResult.buffer.length) {
      chosenResult = closest;
      chosenScale = scale;
    }
  }

  if (!targetReached) {
    // Last resort: try the absolute quality floor at the smallest ladder
    // step. We still report targetReached: false so the UI is honest about
    // it, but this squeezes out a smaller file if one is available.
    if (isCancelled()) throw new CancelledError();
    const floorScale = RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1];
    const width = Math.max(1, Math.round(originalWidth * floorScale));
    const height = Math.max(1, Math.round(originalHeight * floorScale));
    const attempt = await encodeAttempt({
      filePath, format, quality: QUALITY_ABSOLUTE_FLOOR, width, height, originalWidth, originalHeight,
    });
    if (!chosenResult || attempt.buffer.length < chosenResult.buffer.length) {
      chosenResult = { ...attempt, quality: QUALITY_ABSOLUTE_FLOOR };
      chosenScale = floorScale;
    }
  }

  return {
    buffer: chosenResult.buffer,
    format,
    quality: chosenResult.quality,
    width: chosenResult.info.width,
    height: chosenResult.info.height,
    originalWidth,
    originalHeight,
    originalSize,
    compressedSize: chosenResult.buffer.length,
    scale: chosenScale,
    targetReached,
    alreadyUnderTarget: false,
    unchanged: false,
  };
}
