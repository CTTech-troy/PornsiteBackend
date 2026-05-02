import { Router } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getUsers,
  getUserById,
  updateUserStatus,
  updateUserCoins,
  getPlatformCreators,
  updateCreatorStatus,
  updateCreatorType,
  getCreatorApplications,
  getApplicationById,
  updateApplicationStatus,
  getApplicationByToken,
  updateApplicationByToken,
} from '../controller/adminUsers.controller.js';

const router = Router();

router.get('/users', requireAdminAuth, getUsers);
router.get('/users/:id', requireAdminAuth, getUserById);
router.put('/users/:id/status', requireAdminAuth, updateUserStatus);
router.put('/users/:id/coins', requireAdminAuth, updateUserCoins);

router.get('/creators', requireAdminAuth, getPlatformCreators);
router.put('/creators/:id/status', requireAdminAuth, updateCreatorStatus);
router.put('/users/:id/creator-type', requireAdminAuth, updateCreatorType);

router.get('/applications', requireAdminAuth, getCreatorApplications);
router.get('/applications/:id', requireAdminAuth, getApplicationById);
router.put('/applications/:id/status', requireAdminAuth, updateApplicationStatus);

// Public — applicant updates their application via emailed token link (no admin auth)
router.get('/application-update/:token', getApplicationByToken);
router.post('/application-update/:token', updateApplicationByToken);

export default router;
