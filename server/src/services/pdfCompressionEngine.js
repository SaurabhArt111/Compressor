import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray } from 'pdf-lib';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
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
const NAME_FLATE = PDFName.of('FlateDecode');
const NAME_SMASK = PDFName.of('SMask');
const NAME_MASK = PDFName.of('Mask');
const NAME_WIDTH = PDFName.of('Width');
const NAME_HEIGHT = PDFName.of('Height');

/** Normalizes a PDF stream's /Filter entry (a bare Name, or an Array for a
 * decode chain) into an ordered array of filter name strings, e.g. "/DCTDecode".
 * Most real-world writers emit a bare Name for a single filter, but some
 * always wrap it in a one-element Array, and a few legitimately chain a
 * lossless pre-filter (typically FlateDecode) in front of DCTDecode. */
function filterChain(filterEntry) {
  if (!filterEntry) return [];
  if (filterEntry instanceof PDFArray) {
    const arr = [];
    for (let i = 0; i < filterEntry.size(); i += 1) arr.push(filterEntry.get(i)?.toString());
    return arr.filter(Boolean);
  }
  return [filterEntry.toString()];
}

/**
 * Finds every embedded JPEG (DCTDecode) image XObject in a loaded PDFDocument
 * that we can safely re-encode:
 *  - baseline JPEG only, as a bare /DCTDecode filter, a single-element
 *    [/DCTDecode] array (some writers always wrap filters in an array), or
 *    a [/FlateDecode /DCTDecode] chain (rare, but some tools flate-wrap an
 *    already-JPEG-compressed stream) - the FlateDecode layer is inflated
 *    first so Sharp sees a plain JPEG bitstream either way.
 *  - no soft mask / stencil mask (transparency compositing is easy to break
 *    if we change the image's pixel data without touching the mask)
 *  - decodes to the same channel count it started with (guards against
 *    CMYK JPEGs, which Sharp/libvips decodes to RGB - re-encoding one of
 *    those would silently shift colors since the PDF's ColorSpace entry
 *    still says DeviceCMYK)
 *
 * Anything that doesn't qualify is left completely untouched, exactly as
 * the image engine leaves a file untouched when it can't safely help -
 * honesty over forcing a result. Every image object seen (including ones we
 * can't touch) is tallied so the caller can explain *why* nothing was
 * compressible, instead of just reporting a bare zero.
 */
async function findCompressibleImages(pdfDoc) {
  const candidates = [];
  let totalImageObjects = 0;
  const unsupportedFilters = new Set();

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const subtype = obj.dict.get(NAME_SUBTYPE);
    if (!subtype || subtype.toString() !== NAME_IMAGE.toString()) continue;
    totalImageObjects += 1;

    const chain = filterChain(obj.dict.get(NAME_FILTER));
    const lastFilter = chain[chain.length - 1];
    if (lastFilter !== NAME_DCT.toString()) {
      unsupportedFilters.add(lastFilter || 'uncompressed');
      continue;
    }
    // Anything before the final DCTDecode must be losslessly unwrapped
    // first - we only know how to do that for a leading FlateDecode.
    const preFilters = chain.slice(0, -1);
    if (preFilters.some((f) => f !== NAME_FLATE.toString())) {
      unsupportedFilters.add(chain.join(' + '));
      continue;
    }
    if (obj.dict.get(NAME_SMASK) || obj.dict.get(NAME_MASK)) {
      unsupportedFilters.add('has transparency mask');
      continue;
    }

    let original;
    try {
      original = preFilters.length > 0 ? zlib.inflateSync(Buffer.from(obj.contents)) : Buffer.from(obj.contents);
    } catch {
      unsupportedFilters.add('corrupt stream');
      continue;
    }

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
      unsupportedFilters.add('undecodable JPEG stream');
    }
  }
  return { candidates, totalImageObjects, unsupportedFilters };
}

/** Builds a human-readable explanation for why a PDF's images couldn't be
 * (fully) compressed, surfaced in the result so the UI can explain a
 * `imagesFound: 0` or partial result instead of leaving it unexplained. */
function explainShortfall({ isEncrypted, totalImageObjects, unsupportedFilters }) {
  if (isEncrypted) {
    return 'This PDF is encrypted/password-protected, so its embedded images can\'t be read for recompression. Remove the password protection first (e.g. Acrobat\'s "Remove Security", or `qpdf --decrypt in.pdf out.pdf`) and re-upload.';
  }
  if (totalImageObjects === 0) {
    return 'No embedded images were found in this PDF (it appears to be text/vector-only), so there was nothing to recompress.';
  }
  if (unsupportedFilters.size > 0) {
    return `Found ${totalImageObjects} embedded image(s), but none are in a format this tool can safely recompress (detected: ${Array.from(unsupportedFilters).join(', ')}). Only baseline JPEG images can be recompressed today.`;
  }
  return null;
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
    // The stream may have started as [/FlateDecode /DCTDecode]; the
    // re-encoded bytes are plain JPEG, so the Filter must be normalized to
    // just DCTDecode (dropping any pre-filter) to match what's now stored.
    c.obj.dict.set(NAME_FILTER, NAME_DCT);
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
      note: null,
    };
  }

  const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false });
  const pageCount = pdfDoc.getPageCount();
  const { candidates, totalImageObjects, unsupportedFilters } = await findCompressibleImages(pdfDoc);

  const saveDoc = () => pdfDoc.save({ useObjectStreams: false, addDefaultPage: false });

  if (candidates.length === 0) {
    // Nothing we can safely recompress: the document is encrypted (pdf-lib
    // can load an encrypted PDF's structure with ignoreEncryption, but
    // can't decrypt its stream content - a common case for scanner
    // software's default "restricted" PDFs), it's text/vector-only, or
    // every embedded image uses an encoding we chose not to touch (e.g.
    // CCITT fax, JPEG2000, or a CMYK JPEG). Rather than mangle the document
    // trying to force a smaller file, report the honest result - unchanged,
    // target not reached - with a plain-language reason why.
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
      note: explainShortfall({ isEncrypted: pdfDoc.isEncrypted, totalImageObjects, unsupportedFilters }),
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
      note: unsupportedFilters.size > 0
        ? `Recompressing the ${candidates.length} eligible image(s) didn't reduce the file, and ${unsupportedFilters.size > 0 ? 'some embedded images were left untouched' : ''} (detected: ${Array.from(unsupportedFilters).join(', ')}).`
        : null,
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
    note: unsupportedFilters.size > 0
      ? `${totalImageObjects - candidates.length} of ${totalImageObjects} embedded image(s) were left untouched (detected: ${Array.from(unsupportedFilters).join(', ')}).`
      : null,
  };
}
