import express from 'express';
import {
  getJob, serializeJob, startCompression, cancelJob,
} from '../services/jobManager.js';
import {
  QUALITY_FLOOR_DEFAULT, QUALITY_CEILING_DEFAULT, DEFAULT_CONCURRENCY,
} from '../config.js';

const router = express.Router();

const VALID_FORMATS = new Set(['auto', 'jpeg', 'webp', 'avif', 'png']);

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

  const settings = {
    targetMB,
    targetBytes: Math.round(targetMB * 1024 * 1024),
    format,
    qualityFloor: Math.min(Math.max(1, qualityFloor), 100),
    qualityCeiling: Math.min(Math.max(qualityFloor + 1, qualityCeiling), 100),
    concurrency: Math.max(1, Math.min(concurrency, 8)),
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

export default router;
