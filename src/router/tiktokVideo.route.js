/**
 * TikTok-style video API: Supabase storage + Postgres.
 * All routes under /api/videos/tiktok
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { optionalAuth, requireAuth } from '../middleware/authFirebase.js';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import * as tiktokVideo from '../controller/tiktokVideo.controller.js';

const router = express.Router();
const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.VIDEO_VIEW_MAX_PER_MIN || 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('tiktok:views'),
});
const likeLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: Number(process.env.VIDEO_LIKE_MAX_PER_10S || 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('tiktok:likes'),
});
const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.VIDEO_COMMENT_MAX_PER_MIN || 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('tiktok:comments'),
});
// MED-04: Reduced to 50MB bounds
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// Upload (auth required)
router.post('/upload', requireAuth, requireVerifiedEmail, upload.single('video'), tiktokVideo.uploadVideo);

// Feed and profile (public)
router.get('/feed', tiktokVideo.getFeed);
router.get('/user/:userId', tiktokVideo.getVideosByUser);

// Delete comment (must be before /:videoId to avoid "comments" as videoId)
router.delete('/comments/:commentId', requireAuth, requireVerifiedEmail, commentLimiter, tiktokVideo.deleteComment);

// Ads list (must be before /:videoId)
router.get('/ads/list', tiktokVideo.getAds);

// Single video and interactions
router.get('/:videoId', tiktokVideo.getVideo);
router.get('/:videoId/playback', tiktokVideo.getPlaybackState);
router.post('/:videoId/ad-completed', tiktokVideo.markAdCompleted);
router.post('/:videoId/ad-impression', tiktokVideo.recordAdImpression);
router.get('/:videoId/like-status', optionalAuth, tiktokVideo.getLikeStatus);
router.post('/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, tiktokVideo.likeVideo);
router.delete('/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, tiktokVideo.unlikeVideo);
router.post('/:videoId/view', optionalAuth, viewLimiter, tiktokVideo.recordView);
router.get('/:videoId/comments', tiktokVideo.getComments);
router.post('/:videoId/comments', requireAuth, requireVerifiedEmail, commentLimiter, tiktokVideo.addComment);

export default router;
