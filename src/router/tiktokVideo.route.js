/**
 * TikTok-style video API: Supabase storage + Postgres.
 * All routes under /api/videos/tiktok
 */
import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/authFirebase.js';
import * as tiktokVideo from '../controller/tiktokVideo.controller.js';

const router = express.Router();
// MED-04: Reduced to 50MB bounds
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// Upload (auth required)
router.post('/upload', requireAuth, upload.single('video'), tiktokVideo.uploadVideo);

// Feed and profile (public)
router.get('/feed', tiktokVideo.getFeed);
router.get('/user/:userId', tiktokVideo.getVideosByUser);

// Delete comment (must be before /:videoId to avoid "comments" as videoId)
router.delete('/comments/:commentId', requireAuth, tiktokVideo.deleteComment);

// Ads list (must be before /:videoId)
router.get('/ads/list', tiktokVideo.getAds);

// Single video and interactions
router.get('/:videoId', tiktokVideo.getVideo);
router.get('/:videoId/playback', tiktokVideo.getPlaybackState);
router.post('/:videoId/ad-completed', tiktokVideo.markAdCompleted);
router.post('/:videoId/ad-impression', tiktokVideo.recordAdImpression);
router.get('/:videoId/like-status', tiktokVideo.getLikeStatus);
router.post('/:videoId/like', requireAuth, tiktokVideo.likeVideo);
router.delete('/:videoId/like', requireAuth, tiktokVideo.unlikeVideo);
router.post('/:videoId/view', tiktokVideo.recordView);
router.get('/:videoId/comments', tiktokVideo.getComments);
router.post('/:videoId/comments', requireAuth, tiktokVideo.addComment);

export default router;
