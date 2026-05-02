import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getReports,
  updateReport,
  getAuditLogs,
  getAIFlags,
  updateAIFlag,
} from '../controller/adminModeration.controller.js';

const router = Router();
router.use(requireAdminAuth);

router.get('/reports', getReports);
router.put('/reports/:id', updateReport);

router.get('/audit-logs', getAuditLogs);

router.get('/ai-flags', getAIFlags);
router.put('/ai-flags/:id', updateAIFlag);

export default router;
