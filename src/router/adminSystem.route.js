import { Router } from 'express';
import { requireAdminAuth, requireSuperAdmin } from '../middleware/adminAuth.js';
import {
  getSettings,
  updateSettings,
  updateSetting,
  getSystemHealth,
  getEnvOverview,
  getAdminUsers,
  toggleAdminUser,
  getStats,
  getApiHealth,
  getRouteLatency,
} from '../controller/adminSystem.controller.js';
import {
  getExternalFeedConfig,
  updateExternalFeedConfig,
  testExternalFeedConfig,
  getExternalFeedMeta,
} from '../controller/adminExternalFeed.controller.js';

const router = Router();
router.use(requireAdminAuth);

router.get('/stats', getStats);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.put('/settings/:key', updateSetting);

router.get('/health', getSystemHealth);
router.get('/api-health', getApiHealth);
router.get('/route-latency', getRouteLatency);
router.get('/env', getEnvOverview);

router.get('/external-feed', getExternalFeedConfig);
router.put('/external-feed', updateExternalFeedConfig);
router.post('/external-feed/test', testExternalFeedConfig);
router.get('/external-feed/meta', getExternalFeedMeta);

router.get('/admin-users', getAdminUsers);
router.put('/admin-users/:id/toggle', toggleAdminUser);

export default router;
