import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getVideos,
  getVideoById,
  updateVideoStatus,
  deleteVideo,
  getLiveSessions,
  getLiveSessionById,
  updateLiveStatus,
  getRandomSessions,
  getPremiumVideos,
  revalidateVideos,
} from '../controller/adminContent.controller.js';

const router = Router();
router.use(requireAdminAuth);

router.get('/videos', getVideos);
router.post('/videos/revalidate', revalidateVideos);
router.get('/videos/:id', getVideoById);
router.put('/videos/:id/status', updateVideoStatus);
router.delete('/videos/:id', deleteVideo);

router.get('/lives', getLiveSessions);
router.get('/lives/:id', getLiveSessionById);
router.put('/lives/:id/status', updateLiveStatus);

router.get('/random-sessions', getRandomSessions);
router.get('/premium-videos', getPremiumVideos);

export default router;
