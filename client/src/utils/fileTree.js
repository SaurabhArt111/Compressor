export const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'avif', 'heic', 'heif',
]);

export function isSupportedFile(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Reads a FileSystemDirectoryEntry recursively (the API exposed by
 * DataTransferItem.webkitGetAsEntry() when a folder is dropped) and
 * resolves every contained file, each tagged with its path relative to the
 * dropped root folder.
 */
function readDirectoryEntries(dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => {
      dirReader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        readBatch(); // readEntries must be called repeatedly until it returns empty
      }, reject);
    };
    readBatch();
  });
}

async function walkEntry(entry, basePath, out) {
  if (entry.isFile) {
    await new Promise((resolve, reject) => {
      entry.file((file) => {
        const relativePath = basePath ? `${basePath}/${file.name}` : file.name;
        if (isSupportedFile(file.name)) {
          out.push({ file, relativePath });
        }
        resolve();
      }, reject);
    });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readDirectoryEntries(reader);
    const nextBase = basePath ? `${basePath}/${entry.name}` : entry.name;
    await Promise.all(entries.map((child) => walkEntry(child, nextBase, out)));
  }
}

/**
 * Collects { file, relativePath }[] from a DataTransfer (drag & drop),
 * supporting both individual files and whole dropped folders.
 */
export async function collectFilesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  const out = [];

  const supportsEntries = items.length > 0 && typeof items[0].webkitGetAsEntry === 'function';
  if (supportsEntries) {
    const entries = items
      .map((item) => item.webkitGetAsEntry())
      .filter(Boolean);
    await Promise.all(entries.map((entry) => walkEntry(entry, '', out)));
    return out;
  }

  // Fallback for browsers without the entries API: flat file list only.
  const files = Array.from(dataTransfer.files || []);
  for (const file of files) {
    if (isSupportedFile(file.name)) out.push({ file, relativePath: file.name });
  }
  return out;
}

/**
 * Collects { file, relativePath }[] from an <input type="file"> selection,
 * using webkitRelativePath when present (folder-picker inputs).
 */
export function collectFilesFromInput(fileList) {
  const out = [];
  for (const file of Array.from(fileList)) {
    const relativePath = file.webkitRelativePath || file.name;
    if (isSupportedFile(file.name)) out.push({ file, relativePath });
  }
  return out;
}
