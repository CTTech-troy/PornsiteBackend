import express from 'express';
import { fetchPornstars } from '../controller/star.controller.js';

const router = express.Router();

// GET /api/videos/pornstars?limit=100
router.get('/pornstars', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 500); // clamp
  try {
    const data = await fetchPornstars(limit);
    res.status(200).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
});

export default router;
