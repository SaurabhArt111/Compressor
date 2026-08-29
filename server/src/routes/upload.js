import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  UPLOAD_ROOT, MAX_UPLOAD_BYTES, MAX_FILES_PER_JOB, ALLOWED_EXTENSIONS,
  ALLOWED_UPLOAD_EXTENSIONS, ZIP_EXTENSIONS,
} from '../config.js';
import { createJob, addFileToJob, serializeJob } from '../services/jobManager.js';
import { extractZipIntoJob } from '../services/zipExtractor.js';
import { sanitizeRelativePath } from '../utils/paths.js';

const router = express.Router();

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
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
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

function extensionOf(name) {
  return path.extname(name).replace('.', '').toLowerCase();
}

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
  async (req, res) => {
    const job = req.__job;
    const files = req.files || [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No supported files were received.' });
      return;
    }

    const zipFiles = files.filter((f) => ZIP_EXTENSIONS.has(extensionOf(f.__relativePath)));
    const directFiles = files.filter((f) => !ZIP_EXTENSIONS.has(extensionOf(f.__relativePath)));

    for (const file of directFiles) {
      addFileToJob(job, {
        originalName: path.basename(file.__relativePath),
        relativePath: file.__relativePath,
        originalPath: file.path,
        size: file.size,
      });
    }

    const zipErrors = [];
    for (const zipFile of zipFiles) {
      const baseName = path.basename(zipFile.__relativePath, path.extname(zipFile.__relativePath)) || 'archive';
      try {
        // eslint-disable-next-line no-await-in-loop
        const extracted = await extractZipIntoJob({
          zipPath: zipFile.path,
          destRoot: path.join(UPLOAD_ROOT, job.id, 'original'),
          baseName,
          allowedExtensions: ALLOWED_EXTENSIONS,
        });
        for (const item of extracted) {
          addFileToJob(job, {
            originalName: path.basename(item.relativePath),
            relativePath: item.relativePath,
            originalPath: item.absolutePath,
            size: item.size,
          });
        }
        if (extracted.length === 0) {
          zipErrors.push(`${zipFile.__relativePath} contained no supported images or PDFs.`);
        }
      } catch (err) {
        zipErrors.push(`${zipFile.__relativePath} could not be extracted (${err.message || 'invalid archive'}).`);
      } finally {
        // The archive itself is never "compressed" - only its contents are.
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(zipFile.path, { force: true });
      }
    }

    if (job.files.size === 0) {
      res.status(400).json({
        error: zipErrors.length > 0
          ? `No supported files were found. ${zipErrors.join(' ')}`
          : 'No supported image or PDF files were received.',
      });
      return;
    }

    job.status = 'ready';
    const serialized = serializeJob(job);
    if (zipErrors.length > 0) serialized.warnings = zipErrors;
    res.status(201).json(serialized);
  },
);

export default router;
