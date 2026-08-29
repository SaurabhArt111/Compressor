import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_ROOT } from '../config.js';
import { isJobActive } from '../services/jobManager.js';
import { readJobMeta, updateJobLabel } from '../services/jobMeta.js';
import { safeJoin } from '../utils/paths.js';
import { sanitizeLabel } from '../utils/labels.js';

const router = express.Router();

// Internal bookkeeping file (see services/jobMeta.js) - not something the
// user uploaded, so it's hidden from the browsable tree entirely rather
// than showing up as a stray file inside every job folder.
const HIDDEN_ENTRIES = new Set(['meta.json']);

/** Recursively walks a directory into a tree the client can render and
 * browse. Every top-level entry corresponds to one job (past or present):
 * it's tagged with whether that job is still active - the UI uses this to
 * stop someone from deleting/renaming files out from under a compression
 * in progress - and its display name is swapped for the job's real
 * project label (the uploaded folder/ZIP name, or the first file's name)
 * when one was recorded, rather than showing the internal job id.
 * Symlinks are skipped rather than followed, since this tree is reachable
 * (read *and* write) over the network. */
async function buildTree(absolutePath, relativePath, depth) {
  const stat = await fsp.lstat(absolutePath);
  const rawName = path.basename(absolutePath) || relativePath;

  if (stat.isSymbolicLink()) return null;

  if (stat.isFile()) {
    return {
      name: rawName,
      path: relativePath,
      type: 'file',
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  }

  if (!stat.isDirectory()) return null;

  const childNames = await fsp.readdir(absolutePath);
  const children = [];
  let size = 0;
  let fileCount = 0;

  for (const child of childNames) {
    if (depth === 1 && HIDDEN_ENTRIES.has(child)) continue;
    const childAbsolute = path.join(absolutePath, child);
    const childRelative = relativePath ? `${relativePath}/${child}` : child;
    // eslint-disable-next-line no-await-in-loop
    const node = await buildTree(childAbsolute, childRelative, depth + 1);
    if (!node) continue;
    children.push(node);
    size += node.size;
    fileCount += node.type === 'file' ? 1 : node.fileCount;
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const node = {
    name: rawName,
    path: relativePath,
    type: 'dir',
    size,
    fileCount,
    mtime: stat.mtimeMs,
    children,
  };
  if (depth === 1) {
    node.active = isJobActive(rawName);
    // eslint-disable-next-line no-await-in-loop
    const meta = await readJobMeta(rawName);
    if (meta?.label) node.name = meta.label;
  }
  return node;
}

router.get('/tree', async (req, res) => {
  try {
    await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
    const tree = await buildTree(UPLOAD_ROOT, '', 0);
    const children = tree?.children || [];
    res.json({
      children,
      totalSize: children.reduce((sum, c) => sum + c.size, 0),
      totalFiles: children.reduce((sum, c) => sum + (c.type === 'file' ? 1 : c.fileCount), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not read the uploads directory.' });
  }
});

router.delete('/all', async (req, res) => {
  try {
    await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
    const entries = await fsp.readdir(UPLOAD_ROOT);
    const skipped = [];
    for (const entry of entries) {
      if (isJobActive(entry)) {
        skipped.push(entry);
        continue;
      }
      const entryPath = path.join(UPLOAD_ROOT, entry);
      // Retry logic for locked files (common on Windows)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fsp.rm(entryPath, { recursive: true, force: true });
          break;
        } catch (err) {
          if (err.code === 'EBUSY' && attempt < 4) {
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
            continue;
          }
          // If it fails after retries, skip it but continue with others
          skipped.push(entry);
          break;
        }
      }
    }
    res.json({ cleared: true, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not clear the uploads directory.' });
  }
});

router.patch('/rename', async (req, res) => {
  const relativePath = String(req.body?.path || '').replace(/^\/+/, '');
  const rawNewName = req.body?.newName;
  if (!relativePath || !rawNewName) {
    res.status(400).json({ error: 'Both "path" and "newName" are required.' });
    return;
  }

  const segments = relativePath.split('/');
  const topLevel = segments[0];

  // Renaming the top-level node renames the job's *display label* only -
  // the on-disk folder stays keyed by its internal job id forever, since
  // that id is what history records and any still-shareable download
  // links for that job point at. This is also what keeps two uploads that
  // happen to share a folder name fully isolated: their labels can be
  // identical without their files ever touching the same directory.
  if (segments.length === 1) {
    const label = sanitizeLabel(rawNewName);
    try {
      await updateJobLabel(topLevel, label);
      res.json({ renamed: true, path: relativePath, name: label });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Could not rename that folder.' });
    }
    return;
  }

  // Anything nested is a real file/folder inside the job's own sandboxed
  // directory, so this is a genuine filesystem rename (basename only -
  // never a move to a different parent).
  if (isJobActive(topLevel)) {
    res.status(409).json({ error: 'That job is still processing - wait for it to finish (or cancel it) before renaming its files.' });
    return;
  }

  const newBaseName = String(rawNewName).replace(/[/\\]+/g, '-').trim();
  if (!newBaseName || newBaseName === '.' || newBaseName === '..') {
    res.status(400).json({ error: 'Invalid new name.' });
    return;
  }

  let oldAbsolute;
  let newAbsolute;
  let newRelativePath;
  try {
    oldAbsolute = safeJoin(UPLOAD_ROOT, relativePath);
    const parentRelative = segments.slice(0, -1).join('/');
    newRelativePath = `${parentRelative}/${newBaseName}`;
    newAbsolute = safeJoin(UPLOAD_ROOT, newRelativePath);
  } catch {
    res.status(400).json({ error: 'Invalid path.' });
    return;
  }

  try {
    await fsp.access(newAbsolute);
    res.status(409).json({ error: `"${newBaseName}" already exists here.` });
    return;
  } catch {
    // Good - nothing at the destination yet.
  }

  try {
    await fsp.rename(oldAbsolute, newAbsolute);
    res.json({ renamed: true, path: newRelativePath, name: newBaseName });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not rename that item.' });
  }
});

router.delete('/*', async (req, res) => {
  const relativePath = (req.params[0] || '').replace(/^\/+/, '');
  if (!relativePath) {
    res.status(400).json({ error: 'No path given. Use DELETE /api/files/all to clear everything.' });
    return;
  }

  const topLevel = relativePath.split('/')[0];
  if (isJobActive(topLevel)) {
    res.status(409).json({ error: 'That job is still processing - wait for it to finish (or cancel it) before deleting its files.' });
    return;
  }

  let target;
  try {
    target = safeJoin(UPLOAD_ROOT, relativePath);
  } catch {
    res.status(400).json({ error: 'Invalid path.' });
    return;
  }

  // Helper to delete with retry logic for locked files
  async function deleteWithRetry(path, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fsp.rm(path, { recursive: true, force: true });
        return;
      } catch (err) {
        // EBUSY on Windows means the file is locked - retry after a short delay
        if (err.code === 'EBUSY' && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  try {
    await deleteWithRetry(target);
    res.json({ deleted: true, path: relativePath });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not delete that item.' });
  }
});

export default router;
