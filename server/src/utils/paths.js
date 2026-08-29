import path from 'node:path';

/**
 * Strips traversal segments, leading slashes, and drive letters so an
 * untrusted relative path (from an uploaded file's name, or a ZIP entry
 * name) can never escape the directory it's about to be written into.
 * Returns a posix-style relative path (safe to join with path.join, which
 * normalizes separators for the current OS).
 */
export function sanitizeRelativePath(rawName, fallback = 'file') {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  const segments = normalized
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg));
  return segments.length ? segments.join('/') : fallback;
}

/**
 * Resolves `relativePath` against `root` and throws if the result would
 * land outside of `root` (defence in depth on top of sanitizeRelativePath,
 * e.g. against zip-slip style entries or symlink tricks).
 */
export function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Unsafe path escapes its root: ${relativePath}`);
  }
  return target;
}
