import express from 'express';
import { requireAuth } from '../middleware/authFirebase.js';
import { requireApprovedCreator } from '../middleware/requireApprovedCreator.js';
import {
  getOverview,
  getAnalytics,
  getVideos,
  getEarnings,
  getWithdrawals,
  getWithdrawalReceipt,
  createWithdrawal,
  getSettings,
  updateSettings,
  getBanks,
  verifyBankAccount,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getContentAnalytics,
  getAudience,
  getRevenueReport,
  getVerification,
  updateVideo,
  getAnnouncements,
  getActivity,
} from '../controller/creatorStudio.controller.js';
import { getStudioVastAnalytics as getVastAdAnalytics } from '../controller/vastAd.controller.js';

const router = express.Router();

router.get('/banks', getBanks);
router.post('/banks/verify', verifyBankAccount);

router.use(requireAuth);
router.use(requireApprovedCreator);

router.get('/overview', getOverview);
router.get('/analytics', getAnalytics);
router.get('/videos', getVideos);
router.patch('/videos/:id', updateVideo);
router.get('/earnings', getEarnings);
router.get('/withdrawals', getWithdrawals);
router.get('/withdrawals/:id/receipt.pdf', getWithdrawalReceipt);
router.get('/withdrawals/:id/receipt', getWithdrawalReceipt);
router.post('/withdrawals', createWithdrawal);
router.get('/settings', getSettings);
router.patch('/settings', updateSettings);
router.get('/notifications', getNotifications);
router.patch('/notifications/:id/read', markNotificationRead);
router.post('/notifications/read-all', markAllNotificationsRead);
router.get('/content-analytics', getContentAnalytics);
router.get('/audience', getAudience);
router.get('/revenue-report', getRevenueReport);
router.get('/verification', getVerification);
router.get('/announcements', getAnnouncements);
router.get('/activity', getActivity);
router.get('/analytics/ads', getVastAdAnalytics);

export default router;
