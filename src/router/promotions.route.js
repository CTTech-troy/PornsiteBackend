import { Router } from 'express';
import {
  listActiveCampaigns,
  recordClick,
  recordClose,
  recordImpression,
} from '../controller/promotionalCampaign.controller.js';

const router = Router();

router.get('/active', listActiveCampaigns);
router.post('/:id/impression', recordImpression);
router.post('/:id/click', recordClick);
router.post('/:id/close', recordClose);

export default router;
