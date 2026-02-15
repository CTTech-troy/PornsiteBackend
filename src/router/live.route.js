import express from 'express';
import * as liveCtrl from '../controller/live.controller.js';

const router = express.Router();

// POST /api/live/create { hostId }
router.post('/create', async (req, res) => {
  const { hostId } = req.body || {};
  if (!hostId) return res.status(400).json({ ok: false, error: 'missing hostId' });
  try {
    const live = await liveCtrl.createLive(hostId);
    res.json({ ok: true, data: live });
  } catch (err) {
    console.error('live.create error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// POST /api/live/:id/end
router.post('/:id/end', async (req, res) => {
  const { id } = req.params;
  try {
    const payout = await liveCtrl.endLive(id);
    res.json({ ok: true, payout });
  } catch (err) {
    console.error('live.end error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// POST /api/live/:id/pause
router.post('/:id/pause', async (req, res) => {
  const { id } = req.params;
  try {
    const d = await liveCtrl.pauseLive(id);
    res.json({ ok: true, data: d });
  } catch (err) {
    console.error('live.pause error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/live/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const d = await liveCtrl.getLive(id);
    res.json({ ok: true, data: d });
  } catch (err) {
    console.error('live.get error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

export default router;
