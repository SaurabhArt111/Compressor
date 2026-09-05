import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.resolve(SERVER_ROOT, '..', 'client', 'dist');

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';

export const PORT = envInt('PORT', 5555);
export const HOST = process.env.HOST || '0.0.0.0';

// In production behind a specific frontend origin, set CORS_ORIGIN to a
// comma-separated allowlist (e.g. "https://compressor.example.com"). Left as
// "*" by default since this tool is commonly self-hosted on a LAN/behind a
// trusted reverse proxy.
export const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : '*';

export const UPLOAD_ROOT = process.env.UPLOAD_ROOT
  ? path.resolve(process.env.UPLOAD_ROOT)
  : path.join(SERVER_ROOT, 'uploads');
export const HISTORY_FILE = process.env.HISTORY_FILE
  ? path.resolve(process.env.HISTORY_FILE)
  : path.join(SERVER_ROOT, 'data', 'history.json');
export { CLIENT_DIST };

// Hard ceiling on parallel image/PDF jobs regardless of what the client
// requests. Sharp/libvips is memory-efficient (streams pixels rather than
// loading whole files as JS buffers), but decoding several 300-500MB source
// files at once can still spike RAM, so we cap concurrency server-side no
// matter what a client asks for.
export const MAX_SERVER_CONCURRENCY = envInt('MAX_SERVER_CONCURRENCY', 6);
export const DEFAULT_CONCURRENCY = envInt('DEFAULT_CONCURRENCY', 3);

// How many embedded images inside a single PDF are recompressed in parallel.
export const PDF_IMAGE_CONCURRENCY = envInt('PDF_IMAGE_CONCURRENCY', 4);

// Per-file upload ceiling. Generous enough for the 300-500MB (and larger)
// source files this tool targets, with headroom. Override via env for
// deployments that need to go even bigger.
export const MAX_UPLOAD_BYTES = envInt('MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024); // 2GB
export const MAX_FILES_PER_JOB = envInt('MAX_FILES_PER_JOB', 2000);

// Quality search bounds. We never binary-search all the way down to 1:
// below QUALITY_FLOOR_DEFAULT an image is usually already visibly degraded,
// so the engine prefers stepping resolution down over crushing quality
// further, and only drops to QUALITY_ABSOLUTE_FLOOR as a last resort.
export const QUALITY_FLOOR_DEFAULT = envInt('QUALITY_FLOOR_DEFAULT', 35);
export const QUALITY_CEILING_DEFAULT = envInt('QUALITY_CEILING_DEFAULT', 100);
export const QUALITY_ABSOLUTE_FLOOR = envInt('QUALITY_ABSOLUTE_FLOOR', 20);

// Resolution ladder used only when quality alone can't reach the target.
// 1 = original resolution; the engine stops as soon as a step succeeds.
// Shared by the image engine and the PDF engine (for embedded images).
export const RESOLUTION_LADDER = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

// Bounds for the "Maximum Width" dimension-reduction control (Custom
// option). Generous enough to allow any real photo width while still
// rejecting nonsense input (0, negative, absurdly large) from the API.
export const MAX_WIDTH_MIN_PX = 16;
export const MAX_WIDTH_MAX_PX = 20000;

// Raster image formats compressed directly by Sharp.
export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'avif', 'heic', 'heif',
]);

// Documents compressed by re-encoding their embedded images (pdf-lib + Sharp).
export const PDF_EXTENSIONS = new Set(['pdf']);

// Archives that get transparently unzipped on upload; their *contents* (any
// mix of the extensions above) are then queued for compression, and the
// archive itself is discarded once extracted.
export const ZIP_EXTENSIONS = new Set(['zip']);

// Every extension multer is allowed to accept for a single upload request.
export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS, ...ZIP_EXTENSIONS,
]);

// Every extension the compression engines actually know how to shrink.
// (Kept as a separate export, distinct from ALLOWED_UPLOAD_EXTENSIONS, since
// a .zip is accepted for upload but is never itself "compressed" - it is
// unpacked into files drawn from this set.)
export const ALLOWED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS]);

// How long a job's files stay on disk before the cleanup sweep removes them.
export const JOB_RETENTION_MS = envInt('JOB_RETENTION_MS', 24 * 60 * 60 * 1000); // 24h
export const CLEANUP_INTERVAL_MS = envInt('CLEANUP_INTERVAL_MS', 60 * 60 * 1000); // hourly
