import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { fetchPornstars } from '../controller/star.controller.js';
import {
  getVideosPaginated,
  getLatestVideos,
  getCategoryVideos,
  getVideoById as getFeedVideoById,
} from '../controller/videoFeed.controller.js';
import * as videoPublish from '../controller/videoPublish.controller.js';
import * as videoInteractions from '../controller/videoInteractions.controller.js';
import * as search from '../controller/search.controller.js';
import * as trending from '../controller/trending.controller.js';
import * as homeFeed from '../controller/homeFeed.controller.js';
import * as todaysSelection from '../controller/todaysSelection.controller.js';
import * as streamCtrl from '../controller/stream.controller.js';
import * as vastAdCtrl from '../controller/vastAd.controller.js';
import * as importedVideos from '../controller/importedVideos.controller.js';
import * as playbackAnalytics from '../controller/playbackAnalytics.controller.js';
import * as watchHistory from '../controller/watchHistory.controller.js';
import { listPosts } from '../controller/videos.controller.js';
import { requireAuth, optionalAuth } from '../middleware/authFirebase.js';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import tiktokVideoRouter from './tiktokVideo.route.js';

const router = express.Router();

const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.VIDEO_VIEW_MAX_PER_MIN || 120),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('videos:views'),
  message: { success: false, message: 'Too many view events. Please slow down.' },
});

const likeLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: Number(process.env.VIDEO_LIKE_MAX_PER_10S || 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('videos:likes'),
  message: { success: false, message: 'Too many like actions. Please slow down.' },
});

const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.VIDEO_COMMENT_MAX_PER_MIN || 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('videos:comments'),
  message: { success: false, message: 'Too many comments. Please slow down.' },
});

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

router.get('/stream/:id', optionalAuth, streamCtrl.getStreamUrl);

router.post('/playback-events', optionalAuth, playbackAnalytics.recordPlaybackEvent);
router.get('/media/r2/:encodedKey', optionalAuth, videoPublish.streamR2Media);

router.post('/:id/ad-session', optionalAuth, vastAdCtrl.postAdSession);
router.post('/:id/ad-events', optionalAuth, vastAdCtrl.postAdEventHandler);
router.get('/:id/ad-status', optionalAuth, vastAdCtrl.getAdStatus);

// Public feed. Auth is optional so logged-in viewers can still get personalized flags later.
router.get('/', optionalAuth, async (req, res) => {
  const page = req.query.page || 1;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const result = await getVideosPaginated(page, limit, {
      viewerUid: req.uid || null,
      cursor: req.query.cursor || null,
      lean: req.query.lean === '1',
    });
    res.set('Cache-Control', req.uid ? 'private, max-age=15' : 'public, max-age=20, stale-while-revalidate=60');
    res.json(result);
  } catch (err) {
    console.error('videos feed error', err?.message || err);
    res.set('X-API-Fallback', 'videos-feed');
    res.status(200).json({
      data: [],
      total: 0,
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      totalPages: 0,
      hasMore: false,
      nextCursor: null,
      recoverable: true,
      requestId: req.requestId,
    });
  }
});

router.get('/posts', optionalAuth, listPosts);
router.get('/imported', importedVideos.getImportedVideos);
router.get('/imported-categories', importedVideos.getImportedVideoCategories);
router.get('/imported/:id', importedVideos.getImportedVideoById);

// Protected creator publishing routes.
router.post('/upload', requireAuth, requireVerifiedEmail, attachPublishFiles, videoPublish.uploadAndPublish);
router.post('/prepare-upload', requireAuth, videoPublish.prepareUpload);
router.post('/publish', requireAuth, videoPublish.publishFromStoragePath);

router.use('/tiktok', tiktokVideoRouter);

router.get('/creator-level', requireAuth, videoPublish.getCreatorLevel);

// Public platform feed and public video reads.
router.get('/public', optionalAuth, videoPublish.getPublicVideos);
router.get('/public/:videoId', optionalAuth, videoPublish.getVideoById);
router.get('/public/:videoId/comments', videoInteractions.getComments);
router.get('/public/:videoId/like-status', optionalAuth, videoInteractions.getLikeStatus);
router.post('/public/:videoId/view', optionalAuth, viewLimiter, videoInteractions.recordPublicVideoView);

// Protected platform mutations.
router.delete('/public/:videoId', requireAuth, requireVerifiedEmail, videoPublish.deleteVideo);
router.patch('/public/:videoId', requireAuth, requireVerifiedEmail, videoPublish.updateVideo);
router.patch('/public/:videoId/draft', requireAuth, requireVerifiedEmail, videoPublish.setVideoDraft);
router.post('/public/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, videoInteractions.likeVideo);
router.delete('/public/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, videoInteractions.unlikeVideo);
router.post('/public/:videoId/comments', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.addComment);
router.patch('/public/:videoId/comments/:commentId', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.editComment);
router.delete('/public/:videoId/comments/:commentId', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.removeComment);
router.post('/public/:videoId/purchase', requireAuth, videoPublish.purchaseVideo);
router.get('/public/:videoId/purchase-status', requireAuth, videoPublish.getVideoPurchaseStatus);
router.get('/purchases/library', requireAuth, videoPublish.getPurchasedVideosLibrary);
router.get('/purchases/receipt/:purchaseId', requireAuth, videoPublish.getPurchaseReceipt);
router.patch('/purchases/progress/:videoId', requireAuth, videoPublish.updateWatchProgress);
router.patch('/:id/watch-progress', requireAuth, watchHistory.updateWatchProgress);
router.get('/watch/continue', requireAuth, watchHistory.getContinueWatching);
router.get('/:id/related', optionalAuth, watchHistory.getRelatedVideosHandler);

// External discovery routes are public.
router.get('/search/pornstar', search.searchPornstars);
router.get('/search/autocomplete', search.searchAutocomplete);
router.get('/search/global', search.globalSearch);
router.get('/search/config', search.searchConfig);
router.get('/search/suggest', search.searchSuggest);
router.get('/search/trending-queries', search.searchTrendingQueries);
router.get('/search', search.searchVideos);
router.get('/latest', optionalAuth, getLatestVideos);
router.get('/trending', trending.getTrending);
router.get('/category/:slug', optionalAuth, getCategoryVideos);
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
router.post('/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, videoInteractions.likeVideo);
router.delete('/:videoId/like', requireAuth, requireVerifiedEmail, likeLimiter, videoInteractions.unlikeVideo);
router.post('/:videoId/comments', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.addComment);
router.patch('/:videoId/comments/:commentId', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.editComment);
router.delete('/:videoId/comments/:commentId', requireAuth, requireVerifiedEmail, commentLimiter, videoInteractions.removeComment);

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
