import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  forceBackup,
  health,
  logs,
  overview,
  retryFailed,
} from '../controller/adminStorageMonitoring.controller.js';

const router = Router();

router.use(requireAdminAuth);

router.get('/overview', overview);
router.get('/health', health);
router.get('/logs', logs);
router.post('/retry-failed', retryFailed);
router.post('/force-backup', forceBackup);

export default router;
