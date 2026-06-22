import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getOverview,
  getRealtime,
  postRefreshSummary,
} from '../controller/adminAnalytics.controller.js';

const router = Router();

router.use(requireAdminAuth);

router.get('/overview', getOverview);
router.get('/realtime', getRealtime);
router.post('/refresh-summary', postRefreshSummary);

export default router;
