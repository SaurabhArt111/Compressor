import express from 'express';
import {
  getJob, serializeJob, startCompression, cancelJob, retryFile,
} from '../services/jobManager.js';
import {
  QUALITY_FLOOR_DEFAULT, QUALITY_CEILING_DEFAULT, DEFAULT_CONCURRENCY,
  MAX_WIDTH_MIN_PX, MAX_WIDTH_MAX_PX,
} from '../config.js';

const router = express.Router();

const VALID_FORMATS = new Set(['auto', 'jpeg', 'webp', 'avif', 'png']);

/**
 * Resolves the "Maximum Width" request body field down to either `null`
 * (meaning "Original" - the existing compressor's behavior, untouched) or a
 * clamped positive integer pixel width. Accepts a bare number, a numeric
 * string, or the literal 'original' (any case) / omission for "no cap".
 */
function parseMaxWidth(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'original') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(Math.max(n, MAX_WIDTH_MIN_PX), MAX_WIDTH_MAX_PX));
}

router.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(serializeJob(job));
});

router.post('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status === 'processing') {
    res.status(409).json({ error: 'This job is already processing.' });
    return;
  }

  const body = req.body || {};
  const targetMB = Number(body.targetMB);
  if (!Number.isFinite(targetMB) || targetMB <= 0) {
    res.status(400).json({ error: 'targetMB must be a positive number.' });
    return;
  }
  const format = VALID_FORMATS.has(body.format) ? body.format : 'auto';
  const qualityFloor = Number.isFinite(Number(body.qualityFloor)) ? Number(body.qualityFloor) : QUALITY_FLOOR_DEFAULT;
  const qualityCeiling = Number.isFinite(Number(body.qualityCeiling)) ? Number(body.qualityCeiling) : QUALITY_CEILING_DEFAULT;
  const concurrency = Number.isFinite(Number(body.concurrency)) ? Number(body.concurrency) : DEFAULT_CONCURRENCY;
  const maxWidth = parseMaxWidth(body.maxWidth);

  const settings = {
    targetMB,
    targetBytes: Math.round(targetMB * 1024 * 1024),
    format,
    qualityFloor: Math.min(Math.max(1, qualityFloor), 100),
    qualityCeiling: Math.min(Math.max(qualityFloor + 1, qualityCeiling), 100),
    concurrency: Math.max(1, Math.min(concurrency, 8)),
    maxWidth, // null = "Original" (no dimension cap); otherwise a clamped pixel width
  };

  // Fire and forget: progress/completion travel over the socket connection.
  startCompression(job, settings).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Job ${job.id} failed unexpectedly:`, err);
  });

  res.status(202).json({ started: true, jobId: job.id, settings });
});

router.post('/:jobId/cancel', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  cancelJob(job);
  res.json({ cancelling: true });
});

router.post('/:jobId/files/:fileId/retry', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const file = job.files.get(req.params.fileId);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  if (!job.settings) {
    res.status(400).json({ error: 'This job has no saved compression settings to retry with.' });
    return;
  }

  if (!['error', 'cancelled'].includes(file.status)) {
    res.status(409).json({ error: 'Only failed or cancelled files can be retried.' });
    return;
  }

  try {
    const retried = await retryFile(job, file.id);
    res.json({ ok: true, fileId: retried?.id || file.id, status: retried?.status || file.status });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not retry that file.' });
  }
});

export default router;
