import fs from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_ROOT, JOB_RETENTION_MS, CLEANUP_INTERVAL_MS } from '../config.js';

/**
 * Removes job directories under uploads/ that are older than the retention
 * window, skipping anything still tracked as active in the job registry so
 * we never delete files out from under an in-progress or recently-finished
 * job the user hasn't downloaded yet.
 */
export async function sweepOldUploads(isJobActive) {
  let entries;
  try {
    entries = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true });
  } catch {
    return; // uploads dir doesn't exist yet
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (entry) => {
        const jobId = entry.name;
        if (isJobActive(jobId)) return;
        const dirPath = path.join(UPLOAD_ROOT, jobId);
        try {
          const stat = await fs.stat(dirPath);
          if (now - stat.mtimeMs > JOB_RETENTION_MS) {
            // Retry logic for locked files (common on Windows)
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                await fs.rm(dirPath, { recursive: true, force: true });
                break;
              } catch (err) {
                if (err.code === 'EBUSY' && attempt < 4) {
                  await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
                  continue;
                }
                throw err;
              }
            }
          }
        } catch {
          // ignore races where the directory disappeared mid-sweep or other errors
        }
      }),
  );
}

export function startCleanupSchedule(isJobActive) {
  sweepOldUploads(isJobActive).catch(() => {});
  const timer = setInterval(() => {
    sweepOldUploads(isJobActive).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
