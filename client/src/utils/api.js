/**
 * Uploads files via XMLHttpRequest (not fetch) specifically so we get real
 * upload progress events - useful when a single source file can be
 * 300-500MB. The browser streams each File's bytes directly from disk over
 * the network; nothing here ever reads a file into a JS string/base64.
 */
export function uploadFiles(items, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const { file, relativePath } of items) {
      // The 3rd argument overrides the filename sent to the server, which
      // is how the folder path survives the trip (see server preservePath).
      form.append('files', file, relativePath);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) onProgress?.(evt.loaded / evt.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error('Upload failed: invalid server response'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.send(form);
  });
}

export async function startCompression(jobId, settings) {
  const res = await fetch(`/api/compress/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Could not start compression');
  return body;
}

export async function cancelJob(jobId) {
  const res = await fetch(`/api/compress/${jobId}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Could not cancel job');
  return res.json();
}

export async function fetchJob(jobId) {
  const res = await fetch(`/api/compress/${jobId}`);
  if (!res.ok) throw new Error('Job not found');
  return res.json();
}

export async function fetchHistory() {
  const res = await fetch('/api/history');
  if (!res.ok) throw new Error('Could not load history');
  return res.json();
}

export async function clearHistory() {
  const res = await fetch('/api/history', { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not clear history');
  return res.json();
}

export async function removeHistoryRecord(jobId) {
  const res = await fetch(`/api/history/${jobId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not remove history record');
  return res.json();
}

export function downloadFileUrl(jobId, fileId) {
  return `/api/download/${jobId}/${fileId}`;
}

export function downloadZipUrl(jobId) {
  return `/api/download/${jobId}/zip`;
}

export function thumbnailUrl(jobId, fileId, variant) {
  return `/api/download/${jobId}/${fileId}/thumbnail/${variant}`;
}

export async function fetchServerConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Could not load server config');
  return res.json();
}

export async function fetchFileTree() {
  const res = await fetch('/api/files/tree');
  if (!res.ok) throw new Error('Could not load uploaded files');
  return res.json();
}

export async function deleteFilePath(relativePath) {
  const res = await fetch(`/api/files/${relativePath.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not delete that item');
  return body;
}

export async function renameFilePath(relativePath, newName) {
  const res = await fetch('/api/files/rename', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relativePath, newName }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not rename that item');
  return body;
}

export async function clearAllFiles() {
  const res = await fetch('/api/files/all', { method: 'DELETE' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not clear uploaded files');
  return body;
}
