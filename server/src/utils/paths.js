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

/**
 * Strips characters that would be unsafe or ambiguous inside an HTTP
 * `Content-Disposition: attachment; filename="..."` header (quotes,
 * backslashes, control characters) from a name that is otherwise safe to
 * display (e.g. a job label). This is header-safety only - it does not
 * touch path separators, since callers here are building a *download*
 * filename, never a filesystem path.
 */
export function sanitizeHeaderFilename(rawName, fallback = 'download') {
  const cleaned = String(rawName || '')
    .replace(/["\\]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return cleaned || fallback;
}

/**
 * Inserts a `_${suffix}` segment right before a filename's extension, e.g.
 * insertFilenameSuffix('001.jpg', '3000px') -> '001_3000px.jpg'. Used to
 * mark a single downloaded file as dimension-reduced without ever
 * renaming the file stored on disk or inside a batch ZIP.
 */
export function insertFilenameSuffix(fileName, suffix) {
  if (!suffix) return fileName;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return `${base}_${suffix}${ext}`;
}
