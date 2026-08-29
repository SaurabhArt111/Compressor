import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { Server as SocketIOServer } from 'socket.io';

import { PORT, HOST, CLIENT_DIST, CORS_ORIGIN, IS_PRODUCTION, NODE_ENV, MAX_SERVER_CONCURRENCY, MAX_UPLOAD_BYTES, MAX_FILES_PER_JOB } from './config.js';
import uploadRouter from './routes/upload.js';
import compressRouter from './routes/compress.js';
import downloadRouter from './routes/download.js';
import historyRouter from './routes/history.js';
import filesRouter from './routes/files.js';
import { attachSocketServer, isJobActive } from './services/jobManager.js';
import { startCleanupSchedule } from './services/cleanup.js';

const app = express();

// Deployments are commonly run behind a reverse proxy (Nginx, Render,
// Heroku, an ALB, ...); trusting the proxy's X-Forwarded-* headers matters
// for correct client IPs/protocol detection.
app.set('trust proxy', 1);

app.use(helmet({
  // The compressor UI is a same-origin SPA that talks to its own API and
  // loads its thumbnails from itself, so a strict default-* CSP is safe.
  // crossOriginResourcePolicy is relaxed slightly so thumbnails/downloads
  // can be opened directly in a new tab.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: IS_PRODUCTION ? undefined : false,
}));
app.use(compression());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, env: NODE_ENV }));
// Read-only operational limits the client uses to set sensible UI bounds
// (e.g. the concurrency slider) instead of guessing/hardcoding them.
app.get('/api/config', (req, res) => res.json({
  maxServerConcurrency: MAX_SERVER_CONCURRENCY,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxFilesPerJob: MAX_FILES_PER_JOB,
}));
app.use('/api/upload', uploadRouter);
app.use('/api/compress', compressRouter);
app.use('/api/download', downloadRouter);
app.use('/api/history', historyRouter);
app.use('/api/files', filesRouter);

// Serve the built frontend if it exists (production / `npm start`).
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// 404 for anything under /api that didn't match a route above.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Fallback JSON error handler so multer/route errors don't crash the process.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (res.headersSent) { next(err); return; }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = http.createServer(app);
// Large uploads (300-500MB, and beyond) over a slow connection can
// legitimately take a while; don't let Node's default keep-alive/header
// timeouts abort them.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120_000;

const io = new SocketIOServer(server, { cors: { origin: CORS_ORIGIN } });
attachSocketServer(io);

io.on('connection', (socket) => {
  socket.on('join-job', (jobId) => {
    if (typeof jobId === 'string') socket.join(jobId);
  });
  socket.on('leave-job', (jobId) => {
    if (typeof jobId === 'string') socket.leave(jobId);
  });
});

startCleanupSchedule(isJobActive);

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Compressor server listening on http://${HOST}:${PORT} (${NODE_ENV})`);
});

// Graceful shutdown for containerized/process-managed deployments (Docker,
// PM2, systemd, k8s) so in-flight requests get a chance to finish and the
// process doesn't leave the port in a lingering state.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\nReceived ${signal}, shutting down...`);
  io.close();
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('Server closed.');
    process.exit(0);
  });
  // Force-exit if something's still hanging after a grace period.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A single bad request/edge case throwing inside some `await` that isn't
// wrapped in its own try/catch (jobManager.processFile already catches
// everything from the compression engines themselves, but routes are
// simpler code and can still slip up) would otherwise crash the *entire*
// server - killing every other in-progress job and every connected
// client's websocket along with it, for one unrelated failure. Log and
// keep serving everyone else instead.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection (server continues running):', reason);
});

// An uncaught *synchronous* exception means the process is in a genuinely
// unknown state (Node's own guidance: don't try to resume normal
// operation). Log clearly - so a crash shows up as an explained shutdown
// in the server log rather than the process just silently vanishing - then
// exit deliberately so a process manager (Docker/PM2/systemd) can restart
// a clean instance.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception - shutting down for safety:', err);
  io.close();
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 5_000).unref();
});
