import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.resolve(SERVER_ROOT, '..', 'client', 'dist');

export const PORT = Number(process.env.PORT) || 5000;

export const UPLOAD_ROOT = path.join(SERVER_ROOT, 'uploads');
export const HISTORY_FILE = path.join(SERVER_ROOT, 'data', 'history.json');
export { CLIENT_DIST };

// Hard ceiling on parallel image jobs regardless of what the client requests.
// Sharp/libvips is memory-efficient (streams pixels rather than loading whole
// files as JS buffers), but decoding several 300-500MB source images at once
// can still spike RAM, so we cap concurrency server-side no matter what a
// client asks for.
export const MAX_SERVER_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 2;

// Per-file upload ceiling. Generous enough for the 300-500MB source files
// this tool targets, with headroom.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
export const MAX_FILES_PER_JOB = 2000;

// Quality search bounds. We never binary-search all the way down to 1:
// below QUALITY_FLOOR_DEFAULT an image is usually already visibly degraded,
// so the engine prefers stepping resolution down over crushing quality
// further, and only drops to QUALITY_ABSOLUTE_FLOOR as a last resort.
export const QUALITY_FLOOR_DEFAULT = 35;
export const QUALITY_CEILING_DEFAULT = 100;
export const QUALITY_ABSOLUTE_FLOOR = 20;

// Resolution ladder used only when quality alone can't reach the target.
// 1 = original resolution; the engine stops as soon as a step succeeds.
export const RESOLUTION_LADDER = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

export const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'avif', 'heic', 'heif',
]);

// How long a job's files stay on disk before the cleanup sweep removes them.
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
