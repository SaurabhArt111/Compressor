# Compressor

A self-hosted batch file compressor. Drop in images (JPG/PNG/WebP/TIFF/GIF/
BMP/AVIF/HEIC), PDFs, or a ZIP archive of any mix of these — including files
in the 300–500MB range and beyond — pick a target file size, and it finds
the highest quality that still fits. Runs entirely on your own server; there
is no third-party cloud dependency.

- **Frontend:** React + Vite
- **Backend:** Node.js + Express + [Sharp](https://sharp.pixelplumbing.com/) (libvips) + [pdf-lib](https://pdf-lib.js.org/)

## Quick start

```bash
npm install     # installs client + server (npm workspaces)
npm run dev     # starts the backend (:5000) and the Vite dev server (:5173)
```

Open **http://localhost:5173**.

### Production (plain Node)

```bash
npm install
npm run build   # builds the React app into client/dist
npm start       # serves the API + the built frontend from :5000
```

Open **http://localhost:5000**. Requires Node.js **18.17+** (20+ recommended).

### Production (Docker)

```bash
docker compose up -d --build
```

Open **http://localhost:5000**. Uploaded/compressed files and history persist
in named Docker volumes across restarts. See [Deployment](#deployment) below
for env var tuning, a plain `docker build`/`docker run`, and a PM2 option.

## What it does

1. **Drag & drop** images, PDFs, folders, or ZIP archives. Folder structure
   is preserved end to end (upload, processing, and the downloaded ZIP all
   mirror your original layout). A dropped **ZIP is automatically unzipped
   on the server** and every supported file inside it is queued for
   compression — the archive itself is discarded once unpacked.
2. **Pick a target size** — 10MB, 12MB, or a custom value.
3. **Compress.** Each file is searched for the highest quality that still
   fits under the target (see [the algorithm](#the-compression-algorithm)
   below), with live per-file progress and a running elapsed-time counter
   for the whole batch.
4. **Compare** the original and compressed image with a before/after
   slider (PDFs get a document summary panel instead — pages, and how many
   embedded images were recompressed), and see the exact size, format, and
   quality used.
5. **Download** individual files or everything as a ZIP, with folder
   structure intact.

Every completed batch is recorded in **History**, defaults (target size,
format, concurrency, quality bounds) live in **Settings**, and everything
that's ever been uploaded or produced lives in **Files** — a browser for the
server's uploads directory where you can inspect and delete anything.

### If you refresh, close the tab, or lose your connection mid-batch

Compression runs **on the server**, independent of any single browser tab.
If you reload the page, close the tab, or the connection drops while a batch
is running:

- The active job's ID is kept in `localStorage`; reopening the app resumes
  the same job in place (fetches its current status, then rejoins the
  Socket.IO room for further live progress) instead of losing your batch.
- Before that can happen accidentally, a native "leave site?" confirmation
  fires if you try to close/reload the tab while uploading or compressing.
- The batch keeps compressing on the server the whole time regardless of
  whether anyone's tab is open to watch it.

## The compression algorithms

### Images — `server/src/services/compressionEngine.js`

1. **Already small enough?** If the source is already under the target, it
   tries one high-quality re-encode — but only accepts it if that re-encode
   is *also* no larger than the original. If re-encoding doesn't help, it
   keeps the original bytes untouched rather than "compressing" a file into
   something larger.
2. **Binary-search quality** at full resolution for the highest quality
   setting (1–100) whose encoded size still fits under the target.
3. **Resolution ladder.** If even the quality floor overshoots the target,
   it steps resolution down (100% → 90% → 80% … → 40%) and re-runs the
   quality search at each step, stopping at the first one that fits.
4. **Honest fallback.** If nothing on the ladder reaches the target, it
   returns the smallest result found and reports `targetReached: false`
   rather than continuing to crush quality/resolution to force a match.

**Format selection** (when set to "Auto"): transparent images → **WebP**;
opaque photos → **AVIF** below ~6 megapixels, **WebP** above it (AVIF encodes
~30× slower, which matters once you're binary-searching several encodes per
large photo).

### PDFs — `server/src/services/pdfCompressionEngine.js`

PDF size is almost always dominated by embedded photos (scanned documents,
photo-heavy exports), so the engine finds every embedded JPEG image inside
the PDF and runs the **same binary-search-quality + resolution-ladder
algorithm** on them as a group — re-encoding each with [Sharp](https://sharp.pixelplumbing.com/),
writing the result back into the PDF's own image stream, and re-saving with
[pdf-lib](https://pdf-lib.js.org/) — while leaving text, vector graphics,
and document structure completely untouched. No system dependency like
Ghostscript is required, which keeps this simple to deploy.

For safety, only baseline JPEG images without a soft mask/stencil mask are
touched, and any image whose re-encoded channel count doesn't match the
original (a sign it's a CMYK JPEG, which Sharp decodes to RGB) is left
alone rather than risk a color-broken PDF. A PDF with no compressible images
(pure text/vector, or scanned as CCITT fax images) is reported honestly as
`imagesFound: 0`, `unchanged: true` rather than being mangled.

### ZIP archives — `server/src/services/zipExtractor.js`

Uploading a `.zip` streams its entries straight to disk (never buffering the
whole archive or any single entry in memory) into a folder named after the
archive, filtering out anything that isn't a supported image/PDF and
skipping OS noise (`__MACOSX`, `.DS_Store`, `Thumbs.db`). Every entry path is
independently re-sanitized regardless of what the archive's central
directory claims, which defeats "zip-slip" archives crafted with `../../`
traversal segments.

All three engines are exercised by real, generated-file tests — see
[Testing](#testing).

## Efficient handling of very large files

- Uploads use `multer`'s **disk storage** (streamed straight to disk), never
  buffered in memory or passed through the browser as base64.
- Sharp/libvips **streams pixel data** rather than decoding a whole image
  into a JS buffer, so a 500MB TIFF doesn't need 500MB+ of Node heap.
- ZIP extraction streams each entry straight to its destination file too.
- Before/after previews in the UI are small **on-the-fly thumbnails**
  generated by the server — the browser never receives the full-size
  original or compressed file just to render a preview.
- **Bounded concurrency**: you can pick how many files process in parallel
  (Settings → Concurrency), but the server also enforces its own hard
  ceiling (`MAX_SERVER_CONCURRENCY`, default 4) regardless of what's
  requested, so a batch of huge files can't spike RAM by all decoding at
  once. PDF image recompression has its own inner concurrency cap
  (`PDF_IMAGE_CONCURRENCY`) for documents with many embedded photos.
- ZIP downloads are **streamed** via `archiver` directly to the HTTP
  response, not built in memory first.
- Per-file upload ceiling defaults to **2GB** and is configurable
  (`MAX_UPLOAD_BYTES`) for even larger sources.

## Project structure

```
compressor/
├── client/                       # React + Vite frontend
│   └── src/
│       ├── components/           # Dropzone, ResultCard, FileManagerView, HistoryView, ...
│       ├── context/SettingsContext.jsx
│       ├── hooks/useSocket.js    # Socket.IO wiring for live progress
│       └── utils/                # api.js, fileTree.js (folder traversal), format.js
├── server/                       # Node + Express + Sharp + pdf-lib backend
│   └── src/
│       ├── routes/                # upload.js, compress.js, download.js, history.js, files.js
│       ├── services/
│       │   ├── compressionEngine.js    # image compression algorithm
│       │   ├── pdfCompressionEngine.js # PDF compression algorithm
│       │   ├── zipExtractor.js         # safe ZIP-upload extraction
│       │   ├── jobManager.js           # job/file state, concurrency, progress events
│       │   ├── historyStore.js         # JSON-file persisted history
│       │   ├── cleanup.js              # sweeps old uploads after 24h
│       │   └── concurrency.js          # tiny dependency-free limiter
│       ├── utils/paths.js         # shared path-sanitization / traversal guards
│       ├── __test__/api.test.mjs                        # end-to-end HTTP API test
│       └── services/__test__/*.test.js                   # engine/zip unit tests
├── Dockerfile, docker-compose.yml, .dockerignore, .env.example
├── package.json                  # npm workspaces root (install/dev/build/start)
└── README.md
```

## Testing

Four real test suites are included (no mocks — they generate actual
images/PDFs/ZIPs and, for the API suite, run the actual server as a
subprocess):

```bash
cd server
npm test          # runs all four suites below
npm run test:engine  # image compression: quality search, format selection,
                      # transparency, fallback honesty
npm run test:pdf      # PDF compression: embedded-image recompression,
                      # text-only honesty, already-under-target short-circuit
npm run test:zip      # ZIP upload extraction: nested folders, junk filtering,
                      # zip-slip traversal protection
npm run test:api      # full HTTP API: upload (images+PDF+ZIP), compress,
                      # progress, download, ZIP, history, file manager,
                      # active-job delete protection, cancellation
```

Note: `test:engine` generates a real ~90MB TIFF fixture and runs the actual
AVIF/WebP encoders, so a full run takes a few minutes; the other three
finish in seconds.

## Configuration

Most tunables live in `server/src/config.js` and can all be overridden via
environment variables (see `.env.example` for the full list with defaults):

| Env var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `5000` / `0.0.0.0` | Where the server listens |
| `CORS_ORIGIN` | `*` | Comma-separated allowlist, or `*` |
| `UPLOAD_ROOT` / `HISTORY_FILE` | `server/uploads` / `server/data/history.json` | Storage locations |
| `MAX_SERVER_CONCURRENCY` | 4 | Hard cap on parallel image/PDF jobs |
| `PDF_IMAGE_CONCURRENCY` | 4 | Parallel image recompression within one PDF |
| `MAX_UPLOAD_BYTES` | 2GB | Per-file upload limit |
| `QUALITY_FLOOR_DEFAULT` / `_CEILING_DEFAULT` | 35 / 100 | Quality search bounds |
| `QUALITY_ABSOLUTE_FLOOR` | 20 | Last-resort quality floor when the target is unreachable |
| `JOB_RETENTION_MS` | 24h | How long uploaded/compressed files stay on disk before cleanup |

If you change `PORT` in dev mode, also set `SERVER_PORT` when running the
client dev server so its proxy points at the right place:

```bash
PORT=6000 npm run dev -w server
SERVER_PORT=6000 npm run dev -w client
```

## Deployment

### Docker (recommended)

```bash
docker compose up -d --build
```

This builds a multi-stage image (client build → lean production
`node_modules` containing only the server's dependencies → non-root runtime
user), exposes `5000`, and persists `server/uploads` and `server/data` in
named volumes so files and history survive container restarts/upgrades.
Tune it via a `.env` file next to `docker-compose.yml` (copy `.env.example`)
or plain environment variables — `HOST_PORT` picks the host-side port,
everything else maps to the env vars in the table above.

Plain `docker build`/`docker run`, if you'd rather not use Compose:

```bash
docker build -t compressor .
docker run -d -p 5000:5000 \
  -v compressor-uploads:/app/server/uploads \
  -v compressor-data:/app/server/data \
  --name compressor compressor
```

The image includes a `HEALTHCHECK` that polls `/api/health`.

### Plain Node / PM2 / systemd

```bash
npm install
npm run build
NODE_ENV=production PORT=5000 npm start
```

For process supervision, either works well:

```bash
# PM2
pm2 start server/src/index.js --name compressor --cwd . --env production

# systemd (unit file's WorkingDirectory should be the repo root, and
# ExecStart should point at `node server/src/index.js`)
```

### Behind a reverse proxy (Nginx/Caddy/Render/etc.)

- The server trusts `X-Forwarded-*` headers (`app.set('trust proxy', 1)`) so
  client IPs/protocol are reported correctly behind a proxy.
- Large uploads (300–500MB+) need the proxy's own body-size limit raised too
  — e.g. Nginx's `client_max_body_size 0;` (unlimited) or a value matching
  your `MAX_UPLOAD_BYTES`, and generous proxy read/send timeouts, since the
  app itself already disables Node's default request/header timeouts.
- Socket.IO (used for live progress) needs WebSocket upgrade headers proxied
  through (`Upgrade`/`Connection: upgrade`); it falls back to HTTP polling
  automatically if that's not available, just with less snappy progress
  updates.

### Security headers, compression, graceful shutdown

The server ships with `helmet` (a strict CSP in production), gzip response
`compression`, and graceful shutdown on `SIGTERM`/`SIGINT` (closes the HTTP
server and lets in-flight requests finish, important for zero-downtime
container restarts/rolling upgrades).

## Troubleshooting

- **Sharp fails to install / "Could not load the sharp module"**: Sharp
  ships prebuilt binaries per-platform. Delete `node_modules` and
  `package-lock.json` and run `npm install` again on the target machine
  (don't copy `node_modules` between different OSes/architectures — this is
  also why the Docker build always runs `npm ci` inside the target image
  rather than copying a host `node_modules` in).
- **Large uploads time out on a slow network**: the server disables Node's
  default request/header timeouts specifically so 300–500MB uploads aren't
  cut off, but very restrictive proxies/firewalls in front of the server
  could still impose their own limits (see the reverse-proxy notes above).
- **A PDF didn't shrink much**: the PDF engine only recompresses embedded
  JPEG photos; a PDF that's mostly text/vector graphics, or one already
  using CCITT-fax scanned images, has little the engine can safely touch.
  The result will honestly report `imagesFound` and `targetReached: false`
  rather than degrade the document trying to force a smaller file.
- **Files piling up on the server**: the hourly cleanup sweep removes
  finished jobs' files after `JOB_RETENTION_MS` (24h by default), but you
  can also open the **Files** page any time to see exactly what's on disk
  and delete anything immediately.
