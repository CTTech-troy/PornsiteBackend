import express from 'express';
import multer from 'multer';
import { fetchPornstars } from '../controller/star.controller.js';
import { getVideosPaginated, getVideoById as getFeedVideoById } from '../controller/videoFeed.controller.js';
import * as videoPublish from '../controller/videoPublish.controller.js';
import * as videoInteractions from '../controller/videoInteractions.controller.js';
import * as search from '../controller/search.controller.js';
import { requireAuth } from '../middleware/authFirebase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

// GET /api/videos?page=1&limit=20 — paginated feed for home
router.get('/', async (req, res) => {
  const page = req.query.page || 1;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const result = await getVideosPaginated(page, limit);
    res.json(result);
  } catch (err) {
    console.error('videos feed error', err?.message || err);
    res.status(500).json({ data: [], total: 0, page: 1, totalPages: 0 });
  }
});

// ——— Secure upload & publish (Supabase Storage + RTDB), consent required ———
// POST /api/videos/upload — multipart: video file; body: title, description, consentGiven
router.post('/upload', requireAuth, upload.single('video'), videoPublish.uploadAndPublish);

// GET /api/videos/public — public feed (only isLive === true)
router.get('/public', videoPublish.getPublicVideos);
// GET /api/videos/public/:videoId
router.get('/public/:videoId', videoPublish.getVideoById);
// GET /api/videos/public/:videoId/comments
router.get('/public/:videoId/comments', videoPublish.getComments);
// POST /api/videos/public/:videoId/like
router.post('/public/:videoId/like', requireAuth, videoPublish.likeVideo);
// DELETE /api/videos/public/:videoId/like
router.delete('/public/:videoId/like', requireAuth, videoPublish.unlikeVideo);
// GET /api/videos/public/:videoId/like-status (optional auth)
router.get('/public/:videoId/like-status', videoPublish.getLikeStatus);
// POST /api/videos/public/:videoId/comments
router.post('/public/:videoId/comments', requireAuth, videoPublish.addComment);

// GET /api/videos/search/pornstar?q=...&page=1 — RapidAPI pornstar search
router.get('/search/pornstar', search.searchPornstars);
// GET /api/videos/search?q=...&page=1&filter=relevance — RapidAPI video search
router.get('/search', search.searchVideos);

// GET /api/videos/pornstars?limit=100
router.get('/pornstars', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 500); // clamp
  try {
    const data = await fetchPornstars(limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
});

// ——— Unified interactions by videoId (external API or upload) ———
// GET /api/videos/:videoId/like-status (optional auth)
router.get('/:videoId/like-status', videoInteractions.getLikeStatus);
// POST /api/videos/:videoId/like
router.post('/:videoId/like', requireAuth, videoInteractions.likeVideo);
// DELETE /api/videos/:videoId/like
router.delete('/:videoId/like', requireAuth, videoInteractions.unlikeVideo);
// GET /api/videos/:videoId/comments
router.get('/:videoId/comments', videoInteractions.getComments);
// POST /api/videos/:videoId/comments
router.post('/:videoId/comments', requireAuth, videoInteractions.addComment);

// GET /api/videos/:id — single video (from feed cache) for detail page
router.get('/:id', async (req, res) => {
  try {
    const video = await getFeedVideoById(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    return res.json({ data: video });
  } catch (err) {
    console.error('get video by id error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
});

export default router;
