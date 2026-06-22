import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  toggleCampaign,
  updateCampaign,
} from '../controller/adminPromotionalCampaign.controller.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'upload.bin').replace(/[^\w.\-]+/g, '-').slice(-140);
      cb(null, `promo-${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`);
    },
  }),
  limits: {
    files: 2,
    fileSize: Math.max(25 * 1024 * 1024, Number(process.env.PROMOTIONAL_CAMPAIGN_UPLOAD_MAX_BYTES || 300 * 1024 * 1024)),
  },
});

const campaignMediaUpload = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]);

router.use(requireAdminAuth);

router.get('/campaigns', listCampaigns);
router.post('/campaigns', campaignMediaUpload, createCampaign);
router.patch('/campaigns/:id', campaignMediaUpload, updateCampaign);
router.patch('/campaigns/:id/status', toggleCampaign);
router.delete('/campaigns/:id', deleteCampaign);

export default router;
