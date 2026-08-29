import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_ROOT } from '../config.js';

function metaPath(jobId) {
  return path.join(UPLOAD_ROOT, jobId, 'meta.json');
}

/** Writes (or updates) a job's metadata file. Best-effort: a failure here
 * (e.g. the job directory was deleted from under us) shouldn't fail the
 * upload it's attached to, so callers may swallow rejections. */
export async function writeJobMeta(jobId, meta) {
  const filePath = metaPath(jobId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(meta));
}

/** Reads a job's metadata file. Returns null if it doesn't exist or is
 * unreadable/corrupt (e.g. a job created before this feature existed, or
 * one whose meta.json was deleted alongside a manual file-manager cleanup)
 * rather than throwing - callers should fall back to a sensible default. */
export async function readJobMeta(jobId) {
  try {
    const raw = await fsp.readFile(metaPath(jobId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function updateJobLabel(jobId, label) {
  const existing = (await readJobMeta(jobId)) || {};
  const next = { ...existing, label };
  await writeJobMeta(jobId, next);
  return next;
}
