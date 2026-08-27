import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_ROOT, MAX_UPLOAD_BYTES, MAX_FILES_PER_JOB, ALLOWED_EXTENSIONS } from '../config.js';
import { createJob, addFileToJob, serializeJob } from '../services/jobManager.js';

const router = express.Router();

/** Strip traversal segments and leading slashes so an uploaded relative path
 * can never escape its job's upload directory. */
function sanitizeRelativePath(rawName) {
  const normalized = rawName.replace(/\\/g, '/');
  const segments = normalized
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  return segments.length ? segments.join('/') : 'file';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const rel = sanitizeRelativePath(file.originalname);
      file.__relativePath = rel; // stash for the filename callback & handler
      const destDir = path.join(UPLOAD_ROOT, req.jobId, 'original', path.dirname(rel));
      fs.mkdirSync(destDir, { recursive: true });
      cb(null, destDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(file.__relativePath));
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    cb(new Error(`Unsupported file type: .${ext}`));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_JOB },
  // Without this, busboy strips everything but the basename from each
  // part's filename (a sensible default for single-file uploads, but it
  // destroys the "folder/sub/file.jpg" paths we rely on for folder
  // uploads). sanitizeRelativePath() above is what actually guards against
  // path traversal, so it's safe to ask busboy to keep the full path.
  preservePath: true,
});

router.post(
  '/',
  (req, res, next) => {
    const job = createJob();
    req.jobId = job.id;
    req.__job = job;
    next();
  },
  (req, res, next) => {
    upload.array('files', MAX_FILES_PER_JOB)(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message || 'Upload failed' });
        return;
      }
      next();
    });
  },
  (req, res) => {
    const job = req.__job;
    const files = req.files || [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No supported image files were received.' });
      return;
    }
    for (const file of files) {
      addFileToJob(job, {
        originalName: path.basename(file.__relativePath),
        relativePath: file.__relativePath,
        originalPath: file.path,
        size: file.size,
      });
    }
    job.status = 'ready';
    res.status(201).json(serializeJob(job));
  },
);

export default router;
