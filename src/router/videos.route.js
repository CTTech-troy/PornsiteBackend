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
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail.js';
import tiktokVideoRouter from './tiktokVideo.route.js';

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

router.get('/stream/:id', streamCtrl.getStreamUrl);

// Public feed. Auth is optional so logged-in viewers can still get personalized flags later.
router.get('/', optionalAuth, async (req, res) => {
  const page = req.query.page || 1;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const result = await getVideosPaginated(page, limit, { viewerUid: req.uid || null });
    res.json(result);
  } catch (err) {
    console.error('videos feed error', err?.message || err);
    res.status(500).json({ data: [], total: 0, page: 1, totalPages: 0, hasMore: false });
  }
});

router.get('/posts', optionalAuth, listPosts);

// Protected creator publishing routes.
router.post('/upload', requireAuth, requireVerifiedEmail, attachPublishFiles, videoPublish.uploadAndPublish);
router.post('/prepare-upload', requireAuth, videoPublish.prepareUpload);
router.post('/publish', requireAuth, videoPublish.publishFromStoragePath);

router.use('/tiktok', tiktokVideoRouter);

router.get('/creator-level', requireAuth, videoPublish.getCreatorLevel);

// Public platform feed and public video reads.
router.get('/public', optionalAuth, videoPublish.getPublicVideos);
router.get('/public/:videoId', optionalAuth, videoPublish.getVideoById);
router.get('/public/:videoId/comments', videoPublish.getComments);
router.get('/public/:videoId/like-status', optionalAuth, videoPublish.getLikeStatus);
router.post('/public/:videoId/view', optionalAuth, videoInteractions.recordPublicVideoView);

// Protected platform mutations.
router.delete('/public/:videoId', requireAuth, requireVerifiedEmail, videoPublish.deleteVideo);
router.patch('/public/:videoId', requireAuth, requireVerifiedEmail, videoPublish.updateVideo);
router.patch('/public/:videoId/draft', requireAuth, requireVerifiedEmail, videoPublish.setVideoDraft);
router.post('/public/:videoId/like', requireAuth, requireVerifiedEmail, videoPublish.likeVideo);
router.delete('/public/:videoId/like', requireAuth, requireVerifiedEmail, videoPublish.unlikeVideo);
router.post('/public/:videoId/comments', requireAuth, requireVerifiedEmail, videoPublish.addComment);
router.post('/public/:videoId/purchase', requireAuth, videoPublish.purchaseVideo);
router.get('/public/:videoId/purchase-status', requireAuth, videoPublish.getVideoPurchaseStatus);

// External discovery routes are public.
router.get('/search/pornstar', search.searchPornstars);
router.get('/search', search.searchVideos);
router.get('/trending', trending.getTrending);
router.get('/home-feed', optionalAuth, homeFeed.getHomeFeed);
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

// Public reads and protected interactions for the unified feed IDs.
router.get('/:videoId/like-status', optionalAuth, videoInteractions.getLikeStatus);
router.get('/:videoId/comments', videoInteractions.getComments);
router.post('/:videoId/like', requireAuth, requireVerifiedEmail, videoInteractions.likeVideo);
router.delete('/:videoId/like', requireAuth, requireVerifiedEmail, videoInteractions.unlikeVideo);
router.post('/:videoId/comments', requireAuth, requireVerifiedEmail, videoInteractions.addComment);

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const video = await getFeedVideoById(req.params.id, { viewerUid: req.uid || null });
    if (!video) return res.status(404).json({ error: 'Video not found' });
    return res.json({ data: video });
  } catch (err) {
    console.error('get video by id error', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
});

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
