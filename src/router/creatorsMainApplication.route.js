import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/authFirebase.js';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  submitApplication,
  getMyApplications,
  reapplyApplication,
  getApplications,
  getApplicationById,
  approveApplication,
  rejectApplication,
} from '../controller/creatorsMainApplication.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// User routes
router.post('/submit', requireAuth, upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'photos', maxCount: 10 },
  { name: 'videos', maxCount: 5 }
]), submitApplication);

router.get('/my', requireAuth, getMyApplications);

router.post('/reapply', requireAuth, upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'photos', maxCount: 10 },
  { name: 'videos', maxCount: 5 }
]), reapplyApplication);

// Admin routes
router.get('/', requireAdminAuth, getApplications);
router.get('/:id', requireAdminAuth, getApplicationById);
router.put('/:id/approve', requireAdminAuth, approveApplication);
router.put('/:id/reject', requireAdminAuth, rejectApplication);

export default router;