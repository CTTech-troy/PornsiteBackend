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
  getPaymentHistoryAdmin,
  exportPaymentHistoryCsv,
  exportPaymentHistoryExcel,
  exportPaymentHistoryPdf,
  getFraudAlertsAdmin,
  getWebhookEventsAdmin,
  getPaymentAuditAdmin,
  getPaymentReconciliationAdmin,
  getFinanceActivityAdmin,
  getGatewayAnalyticsAdmin,
  getCreatorPayoutsAdmin,
  getCreatorPayoutDetail,
  getFinanceDashboardMetrics,
  getCompanyRevenue,
  getAdRewardAnalyticsAdmin,
  getCreatorEarningsAdmin,
  getRevenueSettingsAdmin,
  saveRevenueSettingsAdmin,
  getRevenueSettingsHistoryAdmin,
  getPremiumPurchasesAdmin,
  getPayoutAnalyticsAdmin,
  getPayoutReceiptAdmin,
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
import * as adNetworkAdmin from '../controller/adNetworkAdmin.controller.js';
import { getAdminVastAnalytics } from '../controller/vastAd.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB cap for finance proofs and ad images.

router.get('/events', requireAdminAuth, requireFinanceAccess, subscribeFinanceEvents);

// All finance routes require admin auth
router.use(requireAdminAuth);
router.use(requireFinanceAccess);

// Finance Hub
router.get('/summary', getFinanceSummary);
router.get('/activity', getFinanceActivityAdmin);

// Membership Plans
router.get('/membership-plans', getMembershipPlansAdmin);
router.post('/membership-plans', createMembershipPlan);
router.put('/membership-plans/:id/toggle', toggleMembershipPlan);
router.delete('/membership-plans/:id', deleteMembershipPlan);

// Subscribers
router.get('/subscribers', getSubscribers);

// Payments
router.get('/payment-history', getPaymentHistoryAdmin);
router.get('/payment-history/export.csv', exportPaymentHistoryCsv);
router.get('/payment-history/export.xlsx', exportPaymentHistoryExcel);
router.get('/payment-history/export.xls', exportPaymentHistoryExcel);
router.get('/payment-history/export.pdf', exportPaymentHistoryPdf);
router.get('/payments', getPaymentsAdmin);
router.get('/fraud-alerts', getFraudAlertsAdmin);
router.get('/webhook-events', getWebhookEventsAdmin);
router.get('/reconciliation', getPaymentReconciliationAdmin);
router.get('/gateway-analytics', getGatewayAnalyticsAdmin);
router.get('/payment-intents/:id/audit', getPaymentAuditAdmin);

// Creator Payouts
router.get('/payouts', getCreatorPayoutsAdmin);
router.get('/payouts/analytics', getPayoutAnalyticsAdmin);
router.get('/dashboard-metrics', getFinanceDashboardMetrics);
router.get('/payouts/dashboard-metrics', getFinanceDashboardMetrics);
router.get('/company-revenue', getCompanyRevenue);
router.get('/ad-reward-analytics', getAdRewardAnalyticsAdmin);
router.get('/creator-earnings/:userId', getCreatorEarningsAdmin);
router.get('/revenue-settings', getRevenueSettingsAdmin);
router.put('/revenue-settings', saveRevenueSettingsAdmin);
router.get('/revenue-settings/history', getRevenueSettingsHistoryAdmin);
router.get('/premium-purchases', getPremiumPurchasesAdmin);
router.get('/payouts/export.csv', exportPayoutsCsv);
router.get('/payouts/:id/receipt.pdf', getPayoutReceiptAdmin);
router.get('/payouts/:id/receipt', getPayoutReceiptAdmin);
router.get('/payouts/:id', getCreatorPayoutDetail);
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
router.get('/vast-ads', getAdminVastAnalytics);
router.post('/ads', createAdCampaign);
router.put('/ads/:id', updateAdCampaign);
router.delete('/ads/:id', deleteAdCampaign);
router.get('/ads/network-settings', adNetworkAdmin.getNetworkSettings);
router.put('/ads/network-settings', adNetworkAdmin.saveNetworkSettings);
router.get('/ads/network-orders', adNetworkAdmin.listNetworkOrders);
router.post('/ads/network-orders/:id/mark-paid', adNetworkAdmin.markOrderPaid);

export default router;
