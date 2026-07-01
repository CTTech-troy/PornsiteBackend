import { Router } from 'express';
import { requireAdminAuth, requireAdsManagementAccess } from '../middleware/adminAuth.js';
import {
  exportReport,
  getOverview,
  getPerformance,
  getReports,
  getRevenue,
  getSettings,
  getZones,
} from '../controller/adsAnalytics.controller.js';

const router = Router();

router.use(requireAdminAuth);
router.use(requireAdsManagementAccess);

router.get('/overview', getOverview);
router.get('/exo-click', getOverview);
router.get('/exoclick', getOverview);
router.get('/adsterra', getOverview);
router.get('/revenue', getRevenue);
router.get('/zones', getZones);
router.get('/performance', getPerformance);
router.get('/reports', getReports);
router.get('/settings', getSettings);
router.get('/export', exportReport);

export default router;
