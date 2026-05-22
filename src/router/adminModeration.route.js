import { Router } from 'express';
import { requireAdminAuth, requireAiModerationAccess } from '../middleware/adminAuth.js';
import {
  getAuditLogs,
  getAIFlags,
  updateAIFlag,
} from '../controller/adminModeration.controller.js';
import {
  createAiSessionAdmin,
  endAiSessionAdmin,
  getAiAnalyticsAdmin,
  getAiFraudAdmin,
  getAiIncidentsAdmin,
  getAiInfrastructureAdmin,
  getAiLiveMonitoringAdmin,
  getAiOverviewAdmin,
  getAiSessionDetailAdmin,
  getAiTrainingAdmin,
  ingestAiModerationSignal,
  reviewAiAlertAdmin,
  triggerAiTrainingAdmin,
  updateAiRuleAdmin,
  workerHeartbeat,
} from '../controller/aiModeration.controller.js';
import { subscribeAuditLogEvents } from '../services/adminAudit.service.js';

const router = Router();

router.get('/audit-logs/events', requireAdminAuth, subscribeAuditLogEvents);
router.post('/ai/ingest', ingestAiModerationSignal);
router.post('/ai/worker/heartbeat', workerHeartbeat);

router.use(requireAdminAuth);

router.get('/audit-logs', getAuditLogs);

router.get('/ai-flags', getAIFlags);
router.put('/ai-flags/:id', updateAIFlag);

router.use('/ai', requireAiModerationAccess);

router.get('/ai/overview', getAiOverviewAdmin);
router.get('/ai/live', getAiLiveMonitoringAdmin);
router.get('/ai/incidents', getAiIncidentsAdmin);
router.get('/ai/analytics', getAiAnalyticsAdmin);
router.get('/ai/fraud', getAiFraudAdmin);
router.get('/ai/training', getAiTrainingAdmin);
router.get('/ai/infrastructure', getAiInfrastructureAdmin);
router.get('/ai/sessions/:sessionId', getAiSessionDetailAdmin);
router.post('/ai/sessions', createAiSessionAdmin);
router.post('/ai/sessions/:sessionId/end', endAiSessionAdmin);
router.post('/ai/alerts/:id/review', reviewAiAlertAdmin);
router.put('/ai/rules/:ruleKey', updateAiRuleAdmin);
router.post('/ai/training/retrain', triggerAiTrainingAdmin);

export default router;
