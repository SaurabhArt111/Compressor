import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_ROOT } from '../config.js';
import { isJobActive } from '../services/jobManager.js';
import { safeJoin } from '../utils/paths.js';

const router = express.Router();

/** Recursively walks a directory into a tree the client can render and
 * browse. Every top-level entry corresponds to one job (past or present),
 * so we tag it with whether that job is still active - the UI uses this to
 * stop someone from deleting files out from under a compression in
 * progress. Symlinks are skipped rather than followed, since this tree is
 * reachable (read *and* delete) over the network. */
async function buildTree(absolutePath, relativePath, depth) {
  const stat = await fsp.lstat(absolutePath);
  const name = path.basename(absolutePath) || relativePath;

  if (stat.isSymbolicLink()) return null;

  if (stat.isFile()) {
    return {
      name,
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
    name,
    path: relativePath,
    type: 'dir',
    size,
    fileCount,
    mtime: stat.mtimeMs,
    children,
  };
  if (depth === 1) node.active = isJobActive(name);
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
      // eslint-disable-next-line no-await-in-loop
      await fsp.rm(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
    res.json({ cleared: true, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not clear the uploads directory.' });
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

  try {
    await fsp.rm(target, { recursive: true, force: true });
    res.json({ deleted: true, path: relativePath });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not delete that item.' });
  }
});

export default router;
