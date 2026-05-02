import { Router } from 'express';
import {
  signupAdmin,
  activateAdmin,
  loginAdmin,
  inviteAdmin,
  verifyInviteToken,
  completeInvite,
  listAdminUsers,
  deleteAdminUser,
  updateUserPermissions,
} from '../controller/admin.controller.js';
import { createFounderAdmin } from '../controller/adminFounder.controller.js';
import { requireAdminAuth, requireSuperAdmin } from '../middleware/adminAuth.js';

const router = Router();

// Founder bootstrap (protected by ADMIN_BOOTSTRAP_SECRET header)
router.post('/auth/founder-create', createFounderAdmin);
router.post('/auth/signup', signupAdmin);
router.post('/auth/activate', activateAdmin);
router.post('/auth/login', loginAdmin);
router.get('/invite/verify/:token', verifyInviteToken);
router.post('/invite/complete', completeInvite);

router.get('/admin-users', requireAdminAuth, listAdminUsers);
router.post('/invite', requireAdminAuth, requireSuperAdmin, inviteAdmin);
router.delete('/admin-users/:id', requireAdminAuth, requireSuperAdmin, deleteAdminUser);
router.put('/admin-users/:id/permissions', requireAdminAuth, requireSuperAdmin, updateUserPermissions);

export default router;
