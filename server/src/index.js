import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { Server as SocketIOServer } from 'socket.io';

import { PORT, HOST, CLIENT_DIST, CORS_ORIGIN, IS_PRODUCTION, NODE_ENV } from './config.js';
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
