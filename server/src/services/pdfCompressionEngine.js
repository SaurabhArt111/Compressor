import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { CancelledError } from './compressionEngine.js';
import { createLimiter } from './concurrency.js';
import {
  QUALITY_FLOOR_DEFAULT,
  QUALITY_CEILING_DEFAULT,
  QUALITY_ABSOLUTE_FLOOR,
  RESOLUTION_LADDER,
  PDF_IMAGE_CONCURRENCY,
} from '../config.js';

const NAME_SUBTYPE = PDFName.of('Subtype');
const NAME_IMAGE = PDFName.of('Image');
const NAME_FILTER = PDFName.of('Filter');
const NAME_DCT = PDFName.of('DCTDecode');
const NAME_SMASK = PDFName.of('SMask');
const NAME_MASK = PDFName.of('Mask');
const NAME_WIDTH = PDFName.of('Width');
const NAME_HEIGHT = PDFName.of('Height');

/**
 * Finds every embedded JPEG (DCTDecode) image XObject in a loaded PDFDocument
 * that we can safely re-encode:
 *  - baseline JPEG only (Filter === DCTDecode, not a filter array/chain)
 *  - no soft mask / stencil mask (transparency compositing is easy to break
 *    if we change the image's pixel data without touching the mask)
 *  - decodes to the same channel count it started with (guards against
 *    CMYK JPEGs, which Sharp/libvips decodes to RGB - re-encoding one of
 *    those would silently shift colors since the PDF's ColorSpace entry
 *    still says DeviceCMYK)
 *
 * Anything that doesn't qualify is left completely untouched, exactly as
 * the image engine leaves a file untouched when it can't safely help -
 * honesty over forcing a result.
 */
async function findCompressibleImages(pdfDoc) {
  const candidates = [];
  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const subtype = obj.dict.get(NAME_SUBTYPE);
    if (!subtype || subtype.toString() !== NAME_IMAGE.toString()) continue;
    const filter = obj.dict.get(NAME_FILTER);
    if (!filter || filter.toString() !== NAME_DCT.toString()) continue;
    if (obj.dict.get(NAME_SMASK) || obj.dict.get(NAME_MASK)) continue;

    const original = Buffer.from(obj.contents);
    try {
      // eslint-disable-next-line no-await-in-loop
      const meta = await sharp(original, { limitInputPixels: false }).metadata();
      if (!meta.width || !meta.height) continue;
      candidates.push({
        obj,
        original,
        width: meta.width,
        height: meta.height,
        channels: meta.channels,
        originalBytes: original.length,
      });
    } catch {
      // Not a JPEG Sharp can decode (corrupt / exotic subsampling) - skip it.
    }
  }
  return candidates;
}

/** Re-encodes every candidate at the given scale/quality and writes the
 * result directly into its (mutable) PDF stream object. Runs with bounded
 * concurrency since a document can embed dozens of images. */
async function applyEncoding(candidates, { scale, quality, isCancelled }) {
  const limit = createLimiter(PDF_IMAGE_CONCURRENCY);
  let totalBytes = 0;
  let skipped = 0;

  await Promise.all(candidates.map((c) => limit(async () => {
    if (isCancelled()) throw new CancelledError();
    const targetWidth = Math.max(1, Math.round(c.width * scale));
    const targetHeight = Math.max(1, Math.round(c.height * scale));

    let pipeline = sharp(c.original, { limitInputPixels: false });
    if (scale < 1) pipeline = pipeline.resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true });
    const { data, info } = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });

    // Safety net described above: if re-encoding changed the channel count
    // (e.g. a CMYK source Sharp silently converted to RGB), bail out for
    // this image and leave its original bytes in place rather than risk a
    // color-broken PDF.
    if (info.channels !== c.channels) {
      totalBytes += c.original.length;
      skipped += 1;
      return;
    }

    c.obj.contents = data;
    if (scale < 1) {
      c.obj.dict.set(NAME_WIDTH, PDFNumber.of(info.width));
      c.obj.dict.set(NAME_HEIGHT, PDFNumber.of(info.height));
    }
    totalBytes += data.length;
  })));

  return { totalBytes, skipped };
}

/**
 * Compress a PDF to fit under targetBytes by recompressing its embedded
 * photos - the dominant source of size in scanned documents and
 * photo-heavy PDFs - while leaving text, vector graphics, and document
 * structure untouched. Mirrors compressImage()'s algorithm and honesty
 * guarantees:
 *
 *   1. Already under target? Return the source bytes unchanged.
 *   2. Binary-search a single JPEG quality applied to every embedded photo,
 *      at full resolution, for the highest quality that still fits.
 *   3. If quality alone can't reach the target, step down a shared
 *      resolution ladder for the embedded images (same ladder the image
 *      engine uses) and re-run the quality search at each step.
 *   4. If nothing reaches the target (or the PDF has no compressible
 *      images at all - e.g. it's pure text/vector), fall back to the
 *      smallest result found and report targetReached: false rather than
 *      degrading things further to force a match.
 */
export async function compressPdf({
  filePath,
  targetBytes,
  qualityFloor = QUALITY_FLOOR_DEFAULT,
  qualityCeiling = QUALITY_CEILING_DEFAULT,
  onProgress,
  isCancelled = () => false,
}) {
  const originalBytes = await fs.readFile(filePath);
  const originalSize = originalBytes.length;

  if (originalSize <= targetBytes) {
    onProgress?.(1, 1, 1);
    return {
      buffer: originalBytes,
      format: 'pdf',
      quality: null,
      originalSize,
      compressedSize: originalSize,
      scale: 1,
      targetReached: true,
      alreadyUnderTarget: true,
      unchanged: true,
      pageCount: null,
      imagesFound: 0,
      imagesCompressed: 0,
    };
  }

  const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false });
  const pageCount = pdfDoc.getPageCount();
  const candidates = await findCompressibleImages(pdfDoc);

  const saveDoc = () => pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });

  if (candidates.length === 0) {
    // Nothing we can safely recompress (text/vector-only PDF, or every
    // embedded image is a format/colorspace we chose not to touch). Rather
    // than mangle the document trying to force a smaller file, report the
    // honest result: unchanged, target not reached.
    onProgress?.(1, 1, 1);
    return {
      buffer: originalBytes,
      format: 'pdf',
      quality: null,
      originalSize,
      compressedSize: originalSize,
      scale: 1,
      targetReached: false,
      alreadyUnderTarget: false,
      unchanged: true,
      pageCount,
      imagesFound: 0,
      imagesCompressed: 0,
    };
  }

  let chosenBuffer = null;
  let chosenQuality = null;
  let chosenScale = 1;
  let chosenSkipped = 0;
  let targetReached = false;

  for (let step = 0; step < RESOLUTION_LADDER.length; step += 1) {
    const scale = RESOLUTION_LADDER[step];
    let lo = qualityFloor;
    let hi = qualityCeiling;
    let bestAtStep = null;
    let closestAtStep = null;
    let iterations = 0;
    const maxIterations = Math.max(1, Math.ceil(Math.log2(hi - lo + 2)));

    while (lo <= hi) {
      if (isCancelled()) throw new CancelledError();
      const mid = Math.floor((lo + hi) / 2);
      // eslint-disable-next-line no-await-in-loop
      const { totalBytes, skipped } = await applyEncoding(candidates, { scale, quality: mid, isCancelled });
      // eslint-disable-next-line no-await-in-loop
      const buffer = await saveDoc();
      iterations += 1;
      onProgress?.(scale, iterations, maxIterations, step, RESOLUTION_LADDER.length);

      const size = buffer.length;
      if (!closestAtStep || Math.abs(size - targetBytes) < Math.abs(closestAtStep.buffer.length - targetBytes)) {
        closestAtStep = { buffer, quality: mid, skipped };
      }
      // The estimate driving the binary search (totalBytes, the sum of
      // re-encoded image sizes) tracks image weight only; the actual saved
      // document size is what we compare against the target.
      if (size <= targetBytes) {
        if (!bestAtStep || mid > bestAtStep.quality) bestAtStep = { buffer, quality: mid, skipped };
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
      void totalBytes;
    }

    if (bestAtStep) {
      chosenBuffer = bestAtStep.buffer;
      chosenQuality = bestAtStep.quality;
      chosenScale = scale;
      chosenSkipped = bestAtStep.skipped;
      targetReached = true;
      break;
    }
    if (!chosenBuffer || closestAtStep.buffer.length < chosenBuffer.length) {
      chosenBuffer = closestAtStep.buffer;
      chosenQuality = closestAtStep.quality;
      chosenScale = scale;
      chosenSkipped = closestAtStep.skipped;
    }
  }

  if (!targetReached) {
    if (isCancelled()) throw new CancelledError();
    const floorScale = RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1];
    const { skipped } = await applyEncoding(candidates, { scale: floorScale, quality: QUALITY_ABSOLUTE_FLOOR, isCancelled });
    const buffer = await saveDoc();
    if (!chosenBuffer || buffer.length < chosenBuffer.length) {
      chosenBuffer = buffer;
      chosenQuality = QUALITY_ABSOLUTE_FLOOR;
      chosenScale = floorScale;
      chosenSkipped = skipped;
    }
  }

  // Never hand back something bigger than what we started with.
  if (chosenBuffer.length >= originalSize) {
    return {
      buffer: originalBytes,
      format: 'pdf',
      quality: null,
      originalSize,
      compressedSize: originalSize,
      scale: 1,
      targetReached: originalSize <= targetBytes,
      alreadyUnderTarget: false,
      unchanged: true,
      pageCount,
      imagesFound: candidates.length,
      imagesCompressed: 0,
    };
  }

  return {
    buffer: chosenBuffer,
    format: 'pdf',
    quality: chosenQuality,
    originalSize,
    compressedSize: chosenBuffer.length,
    scale: chosenScale,
    targetReached,
    alreadyUnderTarget: false,
    unchanged: false,
    pageCount,
    imagesFound: candidates.length,
    imagesCompressed: candidates.length - chosenSkipped,
  };
}
