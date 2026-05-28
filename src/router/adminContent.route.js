import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getVideos,
  getVideoById,
  getImportedVideos,
  getImportedVideoById,
  deleteImportedVideosWithoutIframe,
  updateVideoStatus,
  updateVideoPremium,
  bulkUpdateVideoPremium,
  deleteVideo,
  cleanupEmptyVideos,
  deleteImportedVideo,
  getLiveSessions,
  getLiveSessionById,
  updateLiveStatus,
  getRandomSessions,
  getRandomSessionById,
  forceDisconnectRandomSession,
  getPremiumVideos,
  revalidateVideos,
} from '../controller/adminContent.controller.js';

const router = Router();
router.use(requireAdminAuth);

router.get('/videos', getVideos);
router.post('/videos/revalidate', revalidateVideos);
router.post('/videos/bulk-premium', bulkUpdateVideoPremium);
router.delete('/videos/empty', cleanupEmptyVideos);
router.put('/videos/:id/premium', updateVideoPremium);
router.patch('/videos/:id/premium', updateVideoPremium);
router.get('/videos/:id', getVideoById);
router.put('/videos/:id/status', updateVideoStatus);
router.delete('/videos/:id', deleteVideo);

router.get('/imported-videos', getImportedVideos);
router.delete('/imported-videos/without-iframe', deleteImportedVideosWithoutIframe);
router.get('/imported-videos/:id', getImportedVideoById);
router.delete('/imported-videos/:id', deleteImportedVideo);

router.get('/lives', getLiveSessions);
router.get('/lives/:id', getLiveSessionById);
router.put('/lives/:id/status', updateLiveStatus);

router.get('/random-sessions', getRandomSessions);
router.get('/random-sessions/:id', getRandomSessionById);
router.post('/random-sessions/:id/disconnect', forceDisconnectRandomSession);
router.get('/premium-videos', getPremiumVideos);

export default router;
