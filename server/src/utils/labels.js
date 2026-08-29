import path from 'node:path';

/**
 * Derives a human-readable "project" label for a batch upload, so the
 * Files page can show something meaningful instead of the opaque internal
 * job id:
 *
 *  - A folder (or a single ZIP, whose contents all live under one
 *    extracted-folder prefix) → the real folder/ZIP name.
 *  - A loose handful of files with no shared folder → the first uploaded
 *    file's name (without its extension).
 *
 * `relativePaths` must be the paths *actually queued onto the job* (i.e.
 * after ZIP extraction), in upload order. `firstUploadedName` is the
 * original name of the very first file in the raw upload request (which,
 * for a ZIP-only upload, is the ZIP's own filename) - used only as the
 * fallback when there's no single shared top-level folder.
 */
export function deriveUploadLabel(relativePaths, firstUploadedName) {
  const commonFolder = findCommonTopFolder(relativePaths);
  if (commonFolder) return commonFolder;

  if (firstUploadedName) {
    const base = path.basename(firstUploadedName, path.extname(firstUploadedName));
    if (base) return base;
  }
  return null;
}

function findCommonTopFolder(relativePaths) {
  let folder;
  for (const rel of relativePaths) {
    const slash = rel.indexOf('/');
    if (slash === -1) return null; // a loose file with no folder wrapper at all
    const top = rel.slice(0, slash);
    if (folder === undefined) folder = top;
    else if (folder !== top) return null; // more than one distinct top-level folder
  }
  return folder || null;
}

const MAX_LABEL_LENGTH = 150;

/** Sanitizes a user-facing label (project/folder display name): strips
 * path separators and control characters (this is metadata, not a
 * filesystem path, but keeping it separator-free avoids any ambiguity if
 * it's ever rendered somewhere path-like) and trims to a sane length. */
export function sanitizeLabel(rawLabel, fallback = 'Untitled upload') {
  const cleaned = String(rawLabel || '')
    .replace(/[/\\]+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return cleaned || fallback;
}
