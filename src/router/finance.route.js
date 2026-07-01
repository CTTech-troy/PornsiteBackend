import { Router } from 'express';
import multer from 'multer';
import { requireAdminAuth, requireFinanceAccess } from '../middleware/adminAuth.js';
import {
  getFinanceSummary,
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
  subscribeFinanceEvents,
} from '../controller/adminFinance.controller.js';
import { getAdminVastAnalytics } from '../controller/vastAd.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB cap for finance proofs and ad images.

function adsManagedInCode(_req, res) {
  return res.status(410).json({
    success: false,
    code: 'ADS_MANAGED_IN_CODE',
    message: 'Ad campaigns and ad network settings are managed manually in the codebase and cannot be changed from the admin panel.',
  });
}

router.get('/events', requireAdminAuth, requireFinanceAccess, subscribeFinanceEvents);

// All finance routes require admin auth
router.use(requireAdminAuth);
router.use(requireFinanceAccess);

// Finance Hub
router.get('/summary', getFinanceSummary);
router.get('/activity', getFinanceActivityAdmin);

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
router.post('/ads/upload-image', adsManagedInCode);
router.get('/ads', adsManagedInCode);
router.get('/vast-ads', getAdminVastAnalytics);
router.post('/ads', adsManagedInCode);
router.put('/ads/:id', adsManagedInCode);
router.delete('/ads/:id', adsManagedInCode);
router.get('/ads/network-settings', adsManagedInCode);
router.put('/ads/network-settings', adsManagedInCode);
router.get('/ads/network-orders', adsManagedInCode);
router.post('/ads/network-orders/:id/mark-paid', adsManagedInCode);

export default router;
