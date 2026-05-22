import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  assignFinanceWorkflow,
  notifyPayoutWorkflow,
  payoutAuditWorkflow,
  payoutDailySummaryWorkflow,
  payoutWorkflowFailure,
  verifyDuePayoutsWorkflow,
  verifyPayoutWorkflow,
} from '../controller/payoutWorkflow.controller.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/notify', notifyPayoutWorkflow);
router.post('/assign-finance', assignFinanceWorkflow);
router.post('/verify', verifyPayoutWorkflow);
router.post('/verify-due', verifyDuePayoutsWorkflow);
router.post('/audit', payoutAuditWorkflow);
router.post('/daily-summary', payoutDailySummaryWorkflow);
router.post('/failure', payoutWorkflowFailure);

export default router;
