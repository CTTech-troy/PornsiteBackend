import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import {
  createContentRemoval,
  getAllContentRemovals,
  getContentRemovalById,
  updateContentRemoval,
  updateContentRemovalStatus,
  sendContentRemovalFeedback,
  deleteContentRemoval,
  subscribeContentRemovalEvents,
} from '../controller/ContentRemoval.controller.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const router = express.Router();

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
    fieldSize: 256 * 1024,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, WebP, PDF, DOC, or DOCX files are allowed.'));
    }
    cb(null, true);
  },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.CONTENT_REMOVAL_MAX_PER_HOUR || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many content removal submissions from this connection. Please wait and try again.',
  },
});

function uploadEvidence(req, res, next) {
  upload.array('files', 5)(req, res, (err) => {
    if (!err) return next();
    const isLimit = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT';
    return res.status(400).json({
      success: false,
      message: isLimit ? 'Evidence files must be 10MB or smaller, with up to 5 files per request.' : err.message,
    });
  });
}

// Public submission endpoint.
router.post('/', submitLimiter, uploadEvidence, createContentRemoval);

// Admin live updates.
router.get('/events', requireAdminAuth, subscribeContentRemovalEvents);

// Admin-only moderation endpoints.
router.use(requireAdminAuth);
router.get('/', getAllContentRemovals);
router.get('/:id', getContentRemovalById);
router.put('/:id', updateContentRemoval);
router.patch('/:id', updateContentRemoval);
router.patch('/:id/status', updateContentRemovalStatus);
router.post('/:id/feedback', sendContentRemovalFeedback);
router.delete('/:id', deleteContentRemoval);

export default router;
