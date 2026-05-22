import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  analyticsWorkflow,
  expirePaymentIntentsWorkflow,
  expireMembershipsWorkflow,
  failedPaymentRetryWorkflow,
  fraudAnalysisWorkflow,
  monetizationWorkflowFailure,
  paymentReconciliationWorkflow,
  recurringBillingWorkflow,
  renewalRemindersWorkflow,
  walletVerificationWorkflow,
} from '../controller/monetizationWorkflow.controller.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/expire-memberships', expireMembershipsWorkflow);
router.post('/renewal-reminders', renewalRemindersWorkflow);
router.post('/recurring-billing', recurringBillingWorkflow);
router.post('/failed-payment-retry', failedPaymentRetryWorkflow);
router.post('/expire-payment-intents', expirePaymentIntentsWorkflow);
router.post('/payment-reconciliation', paymentReconciliationWorkflow);
router.post('/fraud-analysis', fraudAnalysisWorkflow);
router.post('/wallet-verification', walletVerificationWorkflow);
router.post('/analytics', analyticsWorkflow);
router.post('/failure', monetizationWorkflowFailure);

export default router;
