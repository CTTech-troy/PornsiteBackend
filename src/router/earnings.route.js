import { Router } from 'express';
import { requireAuth } from '../middleware/authFirebase.js';
import { getEarnings, updateExchangeRate } from '../controller/earnings.controller.js';

const router = Router();

router.get('/', requireAuth, getEarnings);
router.post('/rate', updateExchangeRate);

export default router;
