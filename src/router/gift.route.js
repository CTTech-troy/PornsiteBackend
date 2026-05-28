import express from 'express';
import { getCatalog } from '../controller/gift.controller.js';

const router = express.Router();

// GET /api/gifts - return gift catalog for frontend (names, types, prices in ₦)
router.get('/', async (req, res) => {
  try {
    const catalog = await getCatalog();
    res.json({ ok: true, data: catalog });
  } catch (err) {
    console.error('gifts list error', err?.message || err);
    res.json({ ok: true, data: [], warning: String(err?.message || err) });
  }
});

export default router;
