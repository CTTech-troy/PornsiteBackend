import express from 'express';
import multer from 'multer';
import * as plans from '../controller/membershipPlans.controller.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

// ── Public router (/api/memberships) ─────────────────────────────────────────
export const publicMembershipsRouter = express.Router();
publicMembershipsRouter.get('/', plans.getPublicPlans);

// ── Admin router (/api/admin/memberships) ─────────────────────────────────────
export const adminMembershipsRouter = express.Router();
adminMembershipsRouter.get('/', requireAdminAuth, plans.getAdminPlans);
// image upload must come before /:id routes to avoid "upload-image" matching as an id
adminMembershipsRouter.post('/upload-image', requireAdminAuth, upload.single('image'), plans.uploadPlanImage);
adminMembershipsRouter.post('/', requireAdminAuth, plans.createPlan);
adminMembershipsRouter.put('/:id', requireAdminAuth, plans.updatePlan);
adminMembershipsRouter.patch('/:id/toggle', requireAdminAuth, plans.togglePlan);
adminMembershipsRouter.delete('/:id', requireAdminAuth, plans.deletePlan);
