import express from 'express';
import * as liveCtrl from '../controller/live.controller.js';

const router = express.Router();

// POST /api/live/create { hostId, hostDisplayName? }
router.post('/create', async (req, res) => {
  const { hostId, hostDisplayName } = req.body || {};
  if (!hostId) return res.status(400).json({ ok: false, error: 'missing hostId' });
  try {
    const live = await liveCtrl.createLive(hostId, hostDisplayName);
    res.json({ ok: true, data: live });
  } catch (err) {
    const msg = err?.message || err?.error_description || String(err);
    console.error('live.create error', msg);
    if (msg.includes('not configured') || msg.includes('Supabase')) {
      return res.status(503).json({ ok: false, error: 'Live streaming is not available (database not configured)' });
    }
    if (msg.includes('already have an active live')) {
      return res.status(409).json({ ok: false, error: msg });
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

// GET /api/live/my-active?hostId=... (must be before /:id)
router.get('/my-active', async (req, res) => {
  const hostId = req.query.hostId;
  if (!hostId) return res.status(400).json({ ok: false, error: 'missing hostId' });
  try {
    const live = await liveCtrl.getMyActiveLive(hostId);
    res.json({ ok: true, data: live });
  } catch (err) {
    console.error('live.my-active error', err && err.message ? err.message : err);
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

// GET /api/live?status=live (list active lives)
router.get('/', async (req, res) => {
  const status = req.query.status || 'live';
  try {
    const list = await liveCtrl.listLives(status);
    res.json({ ok: true, data: list });
  } catch (err) {
    console.error('live.list error', err && err.message ? err.message : err);
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
