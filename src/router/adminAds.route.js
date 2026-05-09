import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  analyticsSummary,
  analyticsTop,
  analyticsByPlacement,
} from '../controller/adminAds.controller.js';

const router = Router();

router.use(requireAdminAuth);

router.get('/campaigns', listCampaigns);
router.post('/campaigns', createCampaign);
router.patch('/campaigns/:id', updateCampaign);
router.delete('/campaigns/:id', deleteCampaign);

router.get('/analytics/summary', analyticsSummary);
router.get('/analytics/top', analyticsTop);
router.get('/analytics/by-placement', analyticsByPlacement);

export default router;

