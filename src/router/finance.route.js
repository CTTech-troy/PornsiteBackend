import { Router } from 'express';
import multer from 'multer';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getFinanceSummary,
  getMembershipPlansAdmin,
  createMembershipPlan,
  toggleMembershipPlan,
  deleteMembershipPlan,
  getSubscribers,
  getPaymentsAdmin,
  getCreatorPayoutsAdmin,
  approveCreatorPayout,
  markPayoutPaid,
  rejectCreatorPayout,
  getAdCampaigns,
  createAdCampaign,
  updateAdCampaign,
  deleteAdCampaign,
  uploadAdImage,
} from '../controller/adminFinance.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB cap for ad images

// All finance routes require admin auth
router.use(requireAdminAuth);

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

// Creator Payouts
router.get('/payouts', getCreatorPayoutsAdmin);
router.post('/payouts/:id/approve', approveCreatorPayout);
router.post('/payouts/:id/mark-paid', markPayoutPaid);
router.post('/payouts/:id/reject', rejectCreatorPayout);

// Ad Campaigns — image upload must come before generic :id routes
router.post('/ads/upload-image', upload.single('image'), uploadAdImage);
router.get('/ads', getAdCampaigns);
router.post('/ads', createAdCampaign);
router.put('/ads/:id', updateAdCampaign);
router.delete('/ads/:id', deleteAdCampaign);

export default router;
