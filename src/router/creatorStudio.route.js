import express from 'express';
import { requireAuth } from '../middleware/authFirebase.js';
import {
  getOverview,
  getAnalytics,
  getVideos,
  getEarnings,
  getWithdrawals,
  createWithdrawal,
  getSettings,
  updateSettings,
  getBanks,
  verifyBankAccount,
} from '../controller/creatorStudio.controller.js';

const router = express.Router();

// Bank routes are public (no auth needed — rate limited by Paystack)
router.get('/banks',         getBanks);
router.post('/banks/verify', verifyBankAccount);

router.use(requireAuth);

router.get('/overview',     getOverview);
router.get('/analytics',    getAnalytics);
router.get('/videos',       getVideos);
router.get('/earnings',     getEarnings);
router.get('/withdrawals',  getWithdrawals);
router.post('/withdrawals', createWithdrawal);
router.get('/settings',     getSettings);
router.patch('/settings',   updateSettings);

export default router;
