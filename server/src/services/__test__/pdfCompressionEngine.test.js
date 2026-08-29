/**
 * Lightweight, dependency-free test runner (matches compressionEngine.test.js)
 * that exercises the real PDF compression engine against generated PDFs
 * containing real embedded JPEG images. Run with:
 *   npm run test:pdf   (from server/)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFArray, PDFRawStream } from 'pdf-lib';
import { compressPdf } from '../pdfCompressionEngine.js';

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

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function makePhotoJpeg(width, height, quality) {
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
      ${Array.from({ length: 200 }).map(() => {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = 5 + Math.random() * (width / 15);
    const hue = Math.floor(Math.random() * 360);
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${hue},60%,55%)" fill-opacity="0.3"/>`;
  }).join('')}
    </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** A photo-heavy, multi-page PDF - like a batch of scanned photos exported
 * to a single document - built from several distinct high-quality JPEGs. */
async function makePhotoPdf(filePath, pageCount) {
  const pdfDoc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const jpg = await makePhotoJpeg(1800, 1300, 95);
    // eslint-disable-next-line no-await-in-loop
    const embedded = await pdfDoc.embedJpg(jpg);
    const page = pdfDoc.addPage([620, 820]);
    page.drawImage(embedded, { x: 10, y: 120, width: 600, height: 430 });
    page.drawText(`Scanned page ${i + 1} of ${pageCount}`, { x: 10, y: 760, size: 18 });
  }
  const bytes = await pdfDoc.save();
  await fs.writeFile(filePath, bytes);
  return bytes.length;
}

/** A pure text/vector PDF with no embedded raster images at all. */
async function makeTextOnlyPdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([620, 820]);
  for (let i = 0; i < 40; i += 1) {
    page.drawText(`Line ${i + 1}: the quick brown fox jumps over the lazy dog.`, { x: 40, y: 780 - i * 18, size: 12 });
  }
  page.drawRectangle({ x: 40, y: 40, width: 200, height: 100, borderWidth: 2 });
  const bytes = await pdfDoc.save();
  await fs.writeFile(filePath, bytes);
  return bytes.length;
}

async function run() {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });

  console.log('\n[1/3] Generating a photo-heavy multi-page PDF fixture...');
  const photoPdfPath = path.join(FIXTURE_DIR, 'photo-heavy.pdf');
  const photoPdfSize = await makePhotoPdf(photoPdfPath, 5);
  console.log(`  photo-heavy.pdf: ${kb(photoPdfSize)} (5 pages, 5 embedded photos)`);

  console.log('\n[2/3] Compressing photo-heavy.pdf -> aggressive target (30% of original)');
  const target = Math.round(photoPdfSize * 0.3);
  const t0 = Date.now();
  const result1 = await compressPdf({ filePath: photoPdfPath, targetBytes: target });
  console.log(`  took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  ${kb(result1.originalSize)} -> ${kb(result1.compressedSize)} | quality=${result1.quality} scale=${result1.scale} images=${result1.imagesCompressed}/${result1.imagesFound} targetReached=${result1.targetReached}`);
  assert(result1.compressedSize <= target, 'result stays at/under the target');
  assert(result1.compressedSize < result1.originalSize, 'compressed PDF is smaller than the original');
  assert(result1.targetReached === true, 'target is reported as reached for an achievable case');
  assert(result1.imagesFound === 5, 'found all 5 embedded JPEG images');
  assert(result1.imagesCompressed === 5, 'recompressed all 5 eligible images');
  assert(result1.pageCount === 5, 'reports the correct page count');

  const reloaded = await PDFDocument.load(result1.buffer);
  assert(reloaded.getPageCount() === 5, 'the compressed PDF still loads and has all its pages');

  console.log('\n[3/3] Text-only PDF with no images: honest no-op');
  const textPdfPath = path.join(FIXTURE_DIR, 'text-only.pdf');
  const textPdfSize = await makeTextOnlyPdf(textPdfPath);
  console.log(`  text-only.pdf: ${kb(textPdfSize)}`);
  const result2 = await compressPdf({ filePath: textPdfPath, targetBytes: 10 });
  console.log(`  ${kb(result2.originalSize)} -> ${kb(result2.compressedSize)} | imagesFound=${result2.imagesFound} targetReached=${result2.targetReached} unchanged=${result2.unchanged}`);
  assert(result2.imagesFound === 0, 'finds no compressible images in a text-only PDF');
  assert(result2.unchanged === true, 'leaves a text-only PDF unchanged rather than mangling it');
  assert(result2.targetReached === false, 'honestly reports the (impossible) target was not reached');
  assert(Buffer.compare(result2.buffer, await fs.readFile(textPdfPath)) === 0, 'unchanged PDF bytes are identical to the source');

  console.log('\nBonus: already-under-target PDF short-circuits cleanly');
  const result3 = await compressPdf({ filePath: photoPdfPath, targetBytes: photoPdfSize * 2 });
  assert(result3.alreadyUnderTarget === true, 'flags alreadyUnderTarget when the source already fits');
  assert(result3.unchanged === true, 'alreadyUnderTarget case keeps the source unchanged');
  assert(Buffer.compare(result3.buffer, await fs.readFile(photoPdfPath)) === 0, 'alreadyUnderTarget result is byte-identical to the source');

  console.log('\nReal-world writer quirk: /Filter wrapped as a single-element array [/DCTDecode]');
  const arrayFilterPath = path.join(FIXTURE_DIR, 'array-filter.pdf');
  {
    const jpg = await makePhotoJpeg(900, 700, 95);
    const pdfDoc = await PDFDocument.create();
    const embedded = await pdfDoc.embedJpg(jpg);
    const page = pdfDoc.addPage([620, 820]);
    page.drawImage(embedded, { x: 10, y: 100, width: 600, height: 450 });
    const bytes = await pdfDoc.save();

    // Simulate a writer that always wraps a single filter in an array,
    // rather than emitting a bare /DCTDecode Name (both are valid PDF).
    const loaded = await PDFDocument.load(bytes);
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
        const arr = PDFArray.withContext(loaded.context);
        arr.push(PDFName.of('DCTDecode'));
        obj.dict.set(PDFName.of('Filter'), arr);
      }
    }
    await fs.writeFile(arrayFilterPath, await loaded.save());
  }
  const arrayFilterSize = (await fs.stat(arrayFilterPath)).size;
  const result4 = await compressPdf({ filePath: arrayFilterPath, targetBytes: Math.round(arrayFilterSize * 0.3) });
  console.log(`  imagesFound=${result4.imagesFound} imagesCompressed=${result4.imagesCompressed} targetReached=${result4.targetReached}`);
  assert(result4.imagesFound === 1, 'detects a JPEG whose /Filter is a single-element array, not just a bare Name');
  assert(result4.imagesCompressed === 1, 'successfully recompresses an array-filter JPEG');
  assert(result4.targetReached === true, 'array-filter case still reaches its target');

  console.log('\nReal-world writer quirk: /Filter chain [/FlateDecode /DCTDecode]');
  const chainFilterPath = path.join(FIXTURE_DIR, 'chain-filter.pdf');
  {
    const jpg = await makePhotoJpeg(900, 700, 95);
    const pdfDoc = await PDFDocument.create();
    const embedded = await pdfDoc.embedJpg(jpg);
    const page = pdfDoc.addPage([620, 820]);
    page.drawImage(embedded, { x: 10, y: 100, width: 600, height: 450 });
    const bytes = await pdfDoc.save();

    // Simulate a writer that additionally flate-wraps an already-JPEG
    // stream (wasteful, but legal PDF, and seen in the wild).
    const loaded = await PDFDocument.load(bytes);
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
        const arr = PDFArray.withContext(loaded.context);
        arr.push(PDFName.of('FlateDecode'));
        arr.push(PDFName.of('DCTDecode'));
        obj.dict.set(PDFName.of('Filter'), arr);
        obj.contents = zlib.deflateSync(Buffer.from(obj.contents));
      }
    }
    await fs.writeFile(chainFilterPath, await loaded.save());
  }
  const chainFilterSize = (await fs.stat(chainFilterPath)).size;
  const result5 = await compressPdf({ filePath: chainFilterPath, targetBytes: Math.round(chainFilterSize * 0.3) });
  console.log(`  imagesFound=${result5.imagesFound} imagesCompressed=${result5.imagesCompressed} targetReached=${result5.targetReached}`);
  assert(result5.imagesFound === 1, 'detects and inflates a [/FlateDecode /DCTDecode] chained JPEG');
  assert(result5.imagesCompressed === 1, 'successfully recompresses a flate-wrapped JPEG');
  assert(result5.targetReached === true, 'chain-filter case still reaches its target');
  const reloaded5 = await PDFDocument.load(result5.buffer);
  assert(reloaded5.getPageCount() === 1, 'the re-saved chain-filter PDF still loads correctly');

  console.log('\nSanity: pdf-lib exposes isEncrypted, used to explain encrypted-PDF shortfalls');
  const plainDoc = await PDFDocument.load(await fs.readFile(textPdfPath), { ignoreEncryption: true });
  assert(plainDoc.isEncrypted === false, 'a normal, unencrypted PDF reports isEncrypted: false');

  console.log(`\n${passed} passed, ${failures} failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exitCode = 1;
});
