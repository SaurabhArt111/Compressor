import express from 'express';
import { listHistory, clearHistory, removeHistoryRecord } from '../services/historyStore.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const records = await listHistory();
  res.json(records);
});

router.delete('/', async (req, res) => {
  await clearHistory();
  res.json({ cleared: true });
});

router.delete('/:jobId', async (req, res) => {
  await removeHistoryRecord(req.params.jobId);
  res.json({ removed: true });
});

export default router;
