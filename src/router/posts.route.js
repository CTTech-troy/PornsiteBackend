import express from 'express';
import multer from 'multer';
import * as videoPublish from '../controller/videoPublish.controller.js';
import { listPosts } from '../controller/posts.controller.js';
import { requireAuth, optionalAuth } from '../middleware/authFirebase.js';

const uploadVideoWithThumb = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, fieldSize: 12 * 1024 * 1024 },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

function attachPublishFiles(req, res, next) {
  uploadVideoWithThumb(req, res, (err) => {
    if (err) return next(err);
    const files = req.files || {};
    req.file = files.video?.[0];
    req.thumbnailFile = files.thumbnail?.[0];
    next();
  });
}

const router = express.Router();

router.get('/', optionalAuth, listPosts);
router.post('/', requireAuth, attachPublishFiles, videoPublish.uploadAndPublish);

router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_KEY') {
    return res.status(413).json({ success: false, message: 'Payload too large' });
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ success: false, message: 'Payload too large' });
  }
  return next(err);
});

export default router;
