import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

import { PORT, CLIENT_DIST } from './config.js';
import uploadRouter from './routes/upload.js';
import compressRouter from './routes/compress.js';
import downloadRouter from './routes/download.js';
import historyRouter from './routes/history.js';
import { attachSocketServer, isJobActive } from './services/jobManager.js';
import { startCleanupSchedule } from './services/cleanup.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/upload', uploadRouter);
app.use('/api/compress', compressRouter);
app.use('/api/download', downloadRouter);
app.use('/api/history', historyRouter);

// Serve the built frontend if it exists (production / `npm start`).
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// Fallback JSON error handler so multer/route errors don't crash the process.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = http.createServer(app);
// Large uploads (300-500MB) over a slow connection can legitimately take a
// while; don't let Node's default keep-alive/header timeouts abort them.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120_000;

const io = new SocketIOServer(server, { cors: { origin: '*' } });
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

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Image Compressor server listening on http://localhost:${PORT}`);
});
