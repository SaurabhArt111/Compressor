import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { compressImage, CancelledError, FORMAT_EXTENSION } from './compressionEngine.js';
import { compressPdf } from './pdfCompressionEngine.js';
import { createLimiter } from './concurrency.js';
import { appendHistoryRecord } from './historyStore.js';
import {
  UPLOAD_ROOT, MAX_SERVER_CONCURRENCY, DEFAULT_CONCURRENCY, PDF_EXTENSIONS,
} from '../config.js';

/** @type {Map<string, any>} */
const jobs = new Map();
let io = null;

export function attachSocketServer(socketIo) {
  io = socketIo;
}

function emit(jobId, event, payload) {
  io?.to(jobId).emit(event, payload);
}

export function createJob() {
  const id = nanoid(12);
  const job = {
    id,
    status: 'uploading', // uploading -> ready -> processing -> done
    label: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cancelled: false,
    settings: null,
    files: new Map(), // fileId -> fileEntry
  };
  jobs.set(id, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function isJobActive(jobId) {
  const job = jobs.get(jobId);
  return !!job && (job.status === 'uploading' || job.status === 'processing');
}

function fileKind(originalName) {
  const ext = path.extname(originalName).replace('.', '').toLowerCase();
  return PDF_EXTENSIONS.has(ext) ? 'pdf' : 'image';
}

export function addFileToJob(job, { originalName, relativePath, originalPath, size }) {
  const fileId = nanoid(10);
  const entry = {
    id: fileId,
    originalName,
    relativePath,
    originalPath,
    originalSize: size,
    kind: fileKind(originalName),
    status: 'pending',
    progress: { percent: 0, stage: 'queued' },
    result: null,
    error: null,
    compressedPath: null,
    compressedRelativePath: null,
  };
  job.files.set(fileId, entry);
  return entry;
}

function publicFile(entry) {
  return {
    id: entry.id,
    originalName: entry.originalName,
    relativePath: entry.relativePath,
    originalSize: entry.originalSize,
    kind: entry.kind,
    status: entry.status,
    progress: entry.progress,
    error: entry.error,
    result: entry.result,
  };
}

export function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    label: job.label,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    settings: job.settings,
    files: Array.from(job.files.values()).map(publicFile),
  };
}

function computeOutputRelativePath(relativePath, format) {
  const ext = FORMAT_EXTENSION[format] || format;
  const dir = path.dirname(relativePath);
  const base = path.basename(relativePath, path.extname(relativePath));
  const withExt = `${base}.${ext}`;
  return dir === '.' ? withExt : path.posix.join(dir, withExt);
}

function makeProgressReporter(job, entry) {
  return (scale, iteration, totalIterations, step = 0, totalSteps = 1) => {
    const stepShare = 100 / Math.max(1, totalSteps);
    const withinStep = (iteration / Math.max(1, totalIterations)) * stepShare;
    const percent = Math.min(98, Math.round(step * stepShare + withinStep));
    const stage = scale < 1 ? `optimizing at ${Math.round(scale * 100)}% size` : 'optimizing quality';
    entry.progress = { percent, stage };
    emit(job.id, 'file:progress', { fileId: entry.id, percent, stage });
  };
}

async function processFile(job, entry, settings) {
  if (job.cancelled) {
    entry.status = 'cancelled';
    emit(job.id, 'file:cancelled', { fileId: entry.id });
    return;
  }

  entry.status = 'processing';
  entry.progress = { percent: 1, stage: entry.kind === 'pdf' ? 'reading document' : 'reading image' };
  emit(job.id, 'file:start', { fileId: entry.id });

  try {
    const result = entry.kind === 'pdf'
      ? await compressPdf({
        filePath: entry.originalPath,
        targetBytes: settings.targetBytes,
        qualityFloor: settings.qualityFloor,
        qualityCeiling: settings.qualityCeiling,
        isCancelled: () => job.cancelled,
        onProgress: makeProgressReporter(job, entry),
      })
      : await compressImage({
        filePath: entry.originalPath,
        targetBytes: settings.targetBytes,
        formatPref: settings.format,
        qualityFloor: settings.qualityFloor,
        qualityCeiling: settings.qualityCeiling,
        maxWidth: settings.maxWidth ?? null,
        isCancelled: () => job.cancelled,
        onProgress: makeProgressReporter(job, entry),
      });

    const outRelativePath = result.format === 'pdf'
      ? entry.relativePath
      : computeOutputRelativePath(entry.relativePath, result.format);
    const outAbsolutePath = path.join(UPLOAD_ROOT, job.id, 'compressed', outRelativePath);
    await fs.mkdir(path.dirname(outAbsolutePath), { recursive: true });
    await fs.writeFile(outAbsolutePath, result.buffer);

    entry.compressedPath = outAbsolutePath;
    entry.compressedRelativePath = outRelativePath;
    entry.status = 'done';
    entry.progress = { percent: 100, stage: 'done' };
    entry.result = {
      format: result.format,
      quality: result.quality,
      width: result.width ?? null,
      height: result.height ?? null,
      originalWidth: result.originalWidth ?? null,
      originalHeight: result.originalHeight ?? null,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      reductionPercent: result.originalSize > 0
        ? Math.round((1 - result.compressedSize / result.originalSize) * 1000) / 10
        : 0,
      scale: result.scale,
      targetReached: result.targetReached,
      alreadyUnderTarget: !!result.alreadyUnderTarget,
      unchanged: !!result.unchanged,
      maxWidthApplied: !!result.maxWidthApplied,
      requestedMaxWidth: result.requestedMaxWidth ?? null,
      outputRelativePath: outRelativePath,
      // PDF-only fields; undefined (and thus omitted from JSON) for images.
      pageCount: result.pageCount ?? undefined,
      imagesFound: result.imagesFound ?? undefined,
      imagesCompressed: result.imagesCompressed ?? undefined,
      note: result.note ?? undefined,
    };
    emit(job.id, 'file:done', { fileId: entry.id, file: publicFile(entry) });
  } catch (err) {
    if (err instanceof CancelledError) {
      entry.status = 'cancelled';
      entry.progress = { percent: entry.progress?.percent || 0, stage: 'cancelled' };
      emit(job.id, 'file:cancelled', { fileId: entry.id });
    } else {
      entry.status = 'error';
      entry.error = err.message || 'Compression failed';
      emit(job.id, 'file:error', { fileId: entry.id, error: entry.error });
    }
  }
}

export async function startCompression(job, settings) {
  job.status = 'processing';
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.durationMs = null;
  job.cancelled = false;
  job.settings = settings;
  emit(job.id, 'job:start', { jobId: job.id, fileCount: job.files.size });

  const concurrency = Math.min(
    Math.max(1, Number(settings.concurrency) || DEFAULT_CONCURRENCY),
    MAX_SERVER_CONCURRENCY,
  );
  const limit = createLimiter(concurrency);
  const entries = Array.from(job.files.values());

  await Promise.all(entries.map((entry) => limit(() => processFile(job, entry, settings))));

  job.status = job.cancelled ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  job.durationMs = job.finishedAt - job.startedAt;

  const finished = Array.from(job.files.values());
  const done = finished.filter((f) => f.status === 'done');
  const totalOriginal = done.reduce((sum, f) => sum + (f.result?.originalSize || 0), 0);
  const totalCompressed = done.reduce((sum, f) => sum + (f.result?.compressedSize || 0), 0);
  const summary = {
    jobId: job.id,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    fileCount: finished.length,
    successCount: done.length,
    errorCount: finished.filter((f) => f.status === 'error').length,
    cancelled: job.cancelled,
    totalOriginalSize: totalOriginal,
    totalCompressedSize: totalCompressed,
    averageReductionPercent: totalOriginal > 0
      ? Math.round((1 - totalCompressed / totalOriginal) * 1000) / 10
      : 0,
    targetsReachedCount: done.filter((f) => f.result?.targetReached).length,
    settings,
  };

  if (finished.length > 0) {
    await appendHistoryRecord(summary).catch(() => {});
  }

  emit(job.id, 'job:done', summary);
  return summary;
}

export async function retryFile(job, fileId) {
  const entry = job.files.get(fileId);
  if (!entry || !job.settings) return null;
  if (!['error', 'cancelled'].includes(entry.status)) return entry;

  job.cancelled = false;
  job.status = 'processing';
  entry.error = null;
  entry.result = null;
  entry.progress = { percent: 1, stage: entry.kind === 'pdf' ? 'reading document' : 'reading image' };
  entry.status = 'processing';
  emit(job.id, 'file:start', { fileId: entry.id });

  try {
    await processFile(job, entry, job.settings);
    const stillActive = Array.from(job.files.values()).some((f) => f.status === 'processing');
    if (!stillActive) {
      job.status = job.cancelled ? 'cancelled' : 'done';
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - (job.startedAt ?? 0);
    }
    return entry;
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || 'Compression failed';
    emit(job.id, 'file:error', { fileId: entry.id, error: entry.error });
    return entry;
  }
}

export function cancelJob(job) {
  job.cancelled = true;
  emit(job.id, 'job:cancelling', { jobId: job.id });
}
