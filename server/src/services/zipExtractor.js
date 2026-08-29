import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import { sanitizeRelativePath, safeJoin } from '../utils/paths.js';

// Names that are noise in almost every real-world ZIP (macOS resource
// forks, Windows thumbnail caches, editor swap files) and never something a
// person actually wants compressed.
const IGNORED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function isIgnored(entryPath) {
  const base = path.posix.basename(entryPath);
  if (IGNORED_BASENAMES.has(base)) return true;
  if (entryPath.split('/').some((seg) => seg === '__MACOSX')) return true;
  return false;
}

/**
 * Streams a ZIP archive's entries straight to disk (never buffering the
 * whole archive, or any single entry, in memory - important since this
 * tool is meant to handle very large source files) into
 * `destRoot/<baseName>/<entry's own relative path>`, skipping directories,
 * junk files, and anything whose extension isn't in `allowedExtensions`.
 *
 * Every entry path is re-sanitized independently of whatever the ZIP's
 * central directory claims (defence against "zip-slip" archives crafted
 * with `../../` traversal segments or absolute paths).
 *
 * Returns the list of extracted files as
 * `{ relativePath, absolutePath, size }`, ready to hand to addFileToJob.
 */
export async function extractZipIntoJob({ zipPath, destRoot, baseName, allowedExtensions }) {
  const extracted = [];
  const directory = await unzipper.Open.file(zipPath);

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    if (isIgnored(entry.path)) continue;

    const ext = path.extname(entry.path).replace('.', '').toLowerCase();
    if (!allowedExtensions.has(ext)) {
      continue; // simply don't extract it - nothing to drain, we haven't opened its stream
    }

    const sanitized = sanitizeRelativePath(entry.path, `file-${extracted.length + 1}.${ext}`);
    const relativePath = path.posix.join(baseName, sanitized);
    let absolutePath;
    try {
      absolutePath = safeJoin(destRoot, relativePath);
    } catch {
      continue; // entry tried to escape destRoot even after sanitization - skip it
    }

    // eslint-disable-next-line no-await-in-loop
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      entry.stream()
        .pipe(fs.createWriteStream(absolutePath))
        .on('finish', resolve)
        .on('error', reject);
    });

    // eslint-disable-next-line no-await-in-loop
    const stat = await fsp.stat(absolutePath);
    if (stat.size === 0) {
      // Skip and clean up zero-byte extractions (e.g. a directory entry
      // misreported as a file) rather than queuing an uncompressible file.
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(absolutePath, { force: true });
      continue;
    }

    extracted.push({ relativePath, absolutePath, size: stat.size });
  }

  return extracted;
}
