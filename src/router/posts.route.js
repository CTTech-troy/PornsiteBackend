import express from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { listPosts } from '../controller/videos.controller.js';
import * as videoPublish from '../controller/videoPublish.controller.js';
import { optionalAuth, requireAuth } from '../middleware/authFirebase.js';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail.js';

const router = express.Router();

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const ONE_GB = 1 * 1024 * 1024 * 1024;

const uploadVideoWithThumb = multer({
  storage: diskStorage,
  limits: { fileSize: ONE_GB, fieldSize: 12 * 1024 * 1024 },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

function attachPublishFiles(req, res, next) {
  uploadVideoWithThumb(req, res, (err) => {
    if (err) return next(err);
    const files = req.files || {};
    req.file = files.video?.[0] || files.file?.[0];
    req.thumbnailFile = files.thumbnail?.[0];
    next();
  });
}

router.get('/', optionalAuth, listPosts);
router.post('/', requireAuth, requireVerifiedEmail, attachPublishFiles, videoPublish.uploadAndPublish);
router.post('/prepare-upload', requireAuth, videoPublish.prepareUpload);
router.post('/publish', requireAuth, videoPublish.publishFromStoragePath);

router.use((err, req, res, next) => {
  if (!err) return next();
  if (
    err.code === 'LIMIT_FILE_SIZE' ||
    err.code === 'LIMIT_FIELD_VALUE' ||
    err.code === 'LIMIT_PART_COUNT' ||
    err.code === 'LIMIT_FIELD_KEY'
  ) {
    return res.status(413).json({ success: false, message: 'Payload too large' });
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ success: false, message: 'Payload too large' });
  }
  return next(err);
});

export default router;
