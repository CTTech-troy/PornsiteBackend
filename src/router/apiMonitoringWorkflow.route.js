import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  flushMonitoringEventsWorkflow,
  handleMonitoringWorkflowFailure,
  runMonitoringAggregateWorkflow,
  runMonitoringHealthWorkflow,
  runMonitoringIncidentWorkflow,
  runMonitoringSummaryWorkflow,
} from '../controller/apiMonitoringWorkflow.controller.js';

const router = Router();

// These endpoints are public only so QStash can reach them. They are still
// protected by QStash request signatures and a small abuse limiter.
router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/flush', flushMonitoringEventsWorkflow);
router.post('/aggregate', runMonitoringAggregateWorkflow);
router.post('/health-check', runMonitoringHealthWorkflow);
router.post('/incidents', runMonitoringIncidentWorkflow);
router.post('/summary', runMonitoringSummaryWorkflow);
router.post('/failure', handleMonitoringWorkflowFailure);

export default router;
