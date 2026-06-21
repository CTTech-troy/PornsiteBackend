import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  analyticsWorkflow,
  expirePaymentIntentsWorkflow,
  failedPaymentRetryWorkflow,
  fraudAnalysisWorkflow,
  monetizationWorkflowFailure,
  paymentReconciliationWorkflow,
  walletVerificationWorkflow,
} from '../controller/monetizationWorkflow.controller.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/failed-payment-retry', failedPaymentRetryWorkflow);
router.post('/expire-payment-intents', expirePaymentIntentsWorkflow);
router.post('/payment-reconciliation', paymentReconciliationWorkflow);
router.post('/fraud-analysis', fraudAnalysisWorkflow);
router.post('/wallet-verification', walletVerificationWorkflow);
router.post('/analytics', analyticsWorkflow);
router.post('/failure', monetizationWorkflowFailure);

export default router;
