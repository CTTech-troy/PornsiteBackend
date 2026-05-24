import express from 'express';
import {
  deleteControl,
  getControls,
  getLeaderboard,
  getSettings,
  refreshLeaderboard,
  updateSettings,
  upsertControl,
} from '../controller/adminCreatorLeaderboard.controller.js';

const router = express.Router();

router.get('/', getLeaderboard);
router.post('/refresh', refreshLeaderboard);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.patch('/settings', updateSettings);
router.get('/controls', getControls);
router.post('/controls', upsertControl);
router.put('/controls/:creatorId', upsertControl);
router.patch('/controls/:creatorId', upsertControl);
router.delete('/controls/:creatorId', deleteControl);

export default router;
