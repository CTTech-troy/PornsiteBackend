import { Router } from 'express';
import multer from 'multer';
import { requireAdminAuth, requireFinanceAccess } from '../middleware/adminAuth.js';
import {
  getFinanceSummary,
  getMembershipPlansAdmin,
  createMembershipPlan,
  toggleMembershipPlan,
  deleteMembershipPlan,
  getSubscribers,
  getPaymentsAdmin,
  getFraudAlertsAdmin,
  getWebhookEventsAdmin,
  getPaymentAuditAdmin,
  getPaymentReconciliationAdmin,
  getCreatorPayoutsAdmin,
  getPayoutAnalyticsAdmin,
  approveCreatorPayout,
  exportPayoutsCsv,
  markPayoutPaid,
  markPayoutFailedAdmin,
  markPayoutProcessingAdmin,
  rejectCreatorPayout,
  retryPayoutAdmin,
  uploadPayoutProof,
  getAdCampaigns,
  createAdCampaign,
  updateAdCampaign,
  deleteAdCampaign,
  uploadAdImage,
  subscribeFinanceEvents,
} from '../controller/adminFinance.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB cap for finance proofs and ad images.

router.get('/events', requireAdminAuth, requireFinanceAccess, subscribeFinanceEvents);

// All finance routes require admin auth
router.use(requireAdminAuth);
router.use(requireFinanceAccess);

// Finance Hub
router.get('/summary', getFinanceSummary);

// Membership Plans
router.get('/membership-plans', getMembershipPlansAdmin);
router.post('/membership-plans', createMembershipPlan);
router.put('/membership-plans/:id/toggle', toggleMembershipPlan);
router.delete('/membership-plans/:id', deleteMembershipPlan);

// Subscribers
router.get('/subscribers', getSubscribers);

// Payments
router.get('/payments', getPaymentsAdmin);
router.get('/fraud-alerts', getFraudAlertsAdmin);
router.get('/webhook-events', getWebhookEventsAdmin);
router.get('/reconciliation', getPaymentReconciliationAdmin);
router.get('/payment-intents/:id/audit', getPaymentAuditAdmin);

// Creator Payouts
router.get('/payouts', getCreatorPayoutsAdmin);
router.get('/payouts/analytics', getPayoutAnalyticsAdmin);
router.get('/payouts/export.csv', exportPayoutsCsv);
router.post('/payouts/:id/approve', approveCreatorPayout);
router.post('/payouts/:id/mark-processing', markPayoutProcessingAdmin);
router.post('/payouts/:id/mark-paid', markPayoutPaid);
router.post('/payouts/:id/mark-failed', markPayoutFailedAdmin);
router.post('/payouts/:id/retry', retryPayoutAdmin);
router.post('/payouts/:id/proof', upload.single('proof'), uploadPayoutProof);
router.post('/payouts/:id/reject', rejectCreatorPayout);

// Ad Campaigns — image upload must come before generic :id routes
router.post('/ads/upload-image', upload.single('image'), uploadAdImage);
router.get('/ads', getAdCampaigns);
router.post('/ads', createAdCampaign);
router.put('/ads/:id', updateAdCampaign);
router.delete('/ads/:id', deleteAdCampaign);

export default router;
