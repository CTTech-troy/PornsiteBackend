import express from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { fetchPornstars } from '../controller/star.controller.js';
import { getVideosPaginated, getVideoById as getFeedVideoById } from '../controller/videoFeed.controller.js';
import * as videoPublish from '../controller/videoPublish.controller.js';
import * as videoInteractions from '../controller/videoInteractions.controller.js';
import * as search from '../controller/search.controller.js';
import * as trending from '../controller/trending.controller.js';
import * as homeFeed from '../controller/homeFeed.controller.js';
import * as todaysSelection from '../controller/todaysSelection.controller.js';
import * as streamCtrl from '../controller/stream.controller.js';
import { listPosts } from '../controller/videos.controller.js';
import { requireAuth, optionalAuth } from '../middleware/authFirebase.js';
import tiktokVideoRouter from './tiktokVideo.route.js';

const router = express.Router();

// Disk storage for large files (supports up to 1 GB)
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

router.get('/stream/:id', (req, res) => streamCtrl.getStreamUrl(req, res));

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

// ——— Consolidated Posts/User Dashboard Routes ———
router.get('/posts', optionalAuth, listPosts);

// ——— Consolidated Upload & Publish Routes (Direct and Legacy) ———
router.post('/upload', requireAuth, attachPublishFiles, videoPublish.uploadAndPublish);
router.post('/prepare-upload', requireAuth, videoPublish.prepareUpload);
router.post('/publish',        requireAuth, videoPublish.publishFromStoragePath);

// ——— TikTok-style API ———
router.use('/tiktok', tiktokVideoRouter);

// ——— Metadata & Levels ———
router.get('/creator-level', requireAuth, videoPublish.getCreatorLevel);

// ——— Public Platform Feed ———
router.get('/public', videoPublish.getPublicVideos);
router.get('/public/:videoId', optionalAuth, videoPublish.getVideoById);
router.delete('/public/:videoId', requireAuth, videoPublish.deleteVideo);
router.patch('/public/:videoId', requireAuth, videoPublish.updateVideo);
router.patch('/public/:videoId/draft', requireAuth, videoPublish.setVideoDraft);
router.get('/public/:videoId/comments', videoPublish.getComments);
router.post('/public/:videoId/like', requireAuth, videoPublish.likeVideo);
router.delete('/public/:videoId/like', requireAuth, videoPublish.unlikeVideo);
router.get('/public/:videoId/like-status', videoPublish.getLikeStatus);
router.post('/public/:videoId/comments', requireAuth, videoPublish.addComment);
router.post('/public/:videoId/view', optionalAuth, videoInteractions.recordPublicVideoView);
router.post('/public/:videoId/purchase', requireAuth, videoPublish.purchaseVideo);
router.get('/public/:videoId/purchase-status', requireAuth, videoPublish.getVideoPurchaseStatus);

// ——— External API Search & Discovery ———
router.get('/search/pornstar', search.searchPornstars);
router.get('/search', search.searchVideos);
router.get('/trending', trending.getTrending);
router.get('/home-feed', homeFeed.getHomeFeed);
router.get('/todays-selection', todaysSelection.getTodaysSelection);
router.get('/pornstars', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 500);
  try {
    const data = await fetchPornstars(limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
});

// ——— Unified interactions by videoId ———
router.get('/:videoId/like-status', videoInteractions.getLikeStatus);
router.post('/:videoId/like', requireAuth, videoInteractions.likeVideo);
router.delete('/:videoId/like', requireAuth, videoInteractions.unlikeVideo);
router.get('/:videoId/comments', videoInteractions.getComments);
router.post('/:videoId/comments', requireAuth, videoInteractions.addComment);

// GET /api/videos/:id — single video (from feed cache)
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

// Generic Error Handler for Multer
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
