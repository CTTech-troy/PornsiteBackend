import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import * as plans from '../controller/membershipPlans.controller.js';
import {
  cancelCurrentMembership,
  getAdminMembershipAnalytics,
  getCurrentMembership,
  getMembershipBillingHistory,
  pauseCurrentMembership,
  renewMembership,
  resumeCurrentMembership,
  subscribeMembership,
} from '../controller/membershipSubscriptions.controller.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import { requireAuth } from '../middleware/authFirebase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PAYMENT_CHECKOUT_MAX_PER_MIN || 12),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('memberships:checkout'),
});

// Public router (/api/memberships)
export const publicMembershipsRouter = express.Router();
publicMembershipsRouter.get('/', plans.getPublicPlans);
publicMembershipsRouter.get('/me', requireAuth, getCurrentMembership);
publicMembershipsRouter.post('/subscribe', requireAuth, checkoutLimiter, subscribeMembership);
publicMembershipsRouter.post('/renew', requireAuth, checkoutLimiter, renewMembership);
publicMembershipsRouter.post('/cancel', requireAuth, cancelCurrentMembership);
publicMembershipsRouter.post('/pause', requireAuth, pauseCurrentMembership);
publicMembershipsRouter.post('/resume', requireAuth, resumeCurrentMembership);
publicMembershipsRouter.get('/billing', requireAuth, getMembershipBillingHistory);

// Admin router (/api/admin/memberships)
export const adminMembershipsRouter = express.Router();
adminMembershipsRouter.get('/', requireAdminAuth, plans.getAdminPlans);
adminMembershipsRouter.get('/analytics', requireAdminAuth, getAdminMembershipAnalytics);
// image upload must come before /:id routes to avoid "upload-image" matching as an id
adminMembershipsRouter.post('/upload-image', requireAdminAuth, upload.single('image'), plans.uploadPlanImage);
adminMembershipsRouter.post('/', requireAdminAuth, plans.createPlan);
adminMembershipsRouter.put('/:id', requireAdminAuth, plans.updatePlan);
adminMembershipsRouter.patch('/:id/toggle', requireAdminAuth, plans.togglePlan);
adminMembershipsRouter.delete('/:id', requireAdminAuth, plans.deletePlan);
