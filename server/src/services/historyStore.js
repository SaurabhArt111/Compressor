import fs from 'node:fs/promises';
import path from 'node:path';
import { HISTORY_FILE } from '../config.js';

async function ensureFile() {
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, '[]', 'utf8');
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(HISTORY_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function appendHistoryRecord(record) {
  const all = await readAll();
  all.unshift(record); // newest first
  const trimmed = all.slice(0, 200); // keep the file bounded
  await writeAll(trimmed);
  return record;
}

export async function listHistory() {
  return readAll();
}

export async function clearHistory() {
  await writeAll([]);
}

export async function removeHistoryRecord(jobId) {
  const all = await readAll();
  const next = all.filter((r) => r.jobId !== jobId);
  await writeAll(next);
}
