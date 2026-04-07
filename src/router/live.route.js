import express from 'express';
import * as liveCtrl from '../controller/live.controller.js';

const router = express.Router();

// Admin: cancel all active lives (protected by ADMIN_SECRET env)
router.post('/cancel-all', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.adminSecret || req.body?.adminSecret;
  if (!process.env.ADMIN_SECRET || String(secret) !== String(process.env.ADMIN_SECRET)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const results = await liveCtrl.endAllActiveLives();
    return res.json({ ok: true, cancelled: results.length, results });
  } catch (err) {
    console.error('cancel-all error', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

function emitToLive(io, liveId, event, payload) {
  try {
    const inst = io && typeof io.to === 'function' ? io : null;
    if (inst) inst.to(liveId).emit(event, payload);
  } catch (_) { /* ignore */ }
}

function broadcast(io, event, payload) {
  try {
    if (io && typeof io.emit === 'function') io.emit(event, payload);
  } catch (_) { /* ignore */ }
}

router.post('/start', async (req, res) => {
  const { creatorId, hostDisplayName } = req.body || {};
  if (!creatorId) return res.status(400).json({ ok: false, error: 'missing creatorId' });
  try {
    const live = await liveCtrl.createLive(creatorId, hostDisplayName);
    const session = liveCtrl.buildSession(live, []);
    broadcast(req.app.get('io'), 'live_started', { session });
    res.json({ ok: true, session });
  } catch (err) {
    const msg = err?.message || err?.error_description || String(err);
    console.error('live.start error', msg);
    if (msg.includes('not configured') || msg.includes('Supabase')) {
      return res.status(503).json({ ok: false, error: 'Live streaming is not available (database not configured)' });
    }
    if (msg.includes('must end your current live')) {
      return res.status(409).json({ ok: false, error: msg });
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/join/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });
  try {
    await liveCtrl.joinLive(sessionId, userId);
    const session = await liveCtrl.getLiveSession(sessionId);
    const io = req.app.get('io');
    if (session && io) {
      emitToLive(io, sessionId, 'user_joined', { userId, session });
      emitToLive(io, sessionId, 'update-viewers', { viewersCount: session.viewersCount });
    }
    res.json({ ok: true, session });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('live.join error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/leave/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });
  try {
    await liveCtrl.leaveLive(sessionId, userId);
    const session = await liveCtrl.getLiveSession(sessionId);
    const io = req.app.get('io');
    if (session && io) {
      emitToLive(io, sessionId, 'user_left', { userId, session });
      emitToLive(io, sessionId, 'update-viewers', { viewersCount: session.viewersCount });
    }
    res.json({ ok: true, session });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('live.leave error', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

router.post('/end/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { creatorId } = req.body || {};
  if (!creatorId) return res.status(400).json({ ok: false, error: 'missing creatorId' });
  try {
    const payout = await liveCtrl.endLive(sessionId, { requesterId: creatorId });
    const io = req.app.get('io');
    emitToLive(io, sessionId, 'live_ended', { sessionId, payout });
    emitToLive(io, sessionId, 'live-ended', payout);
    broadcast(io, 'live_ended', { sessionId, payout });
    res.json({ ok: true, payout, sessionId });
  } catch (err) {
    console.error('live.end session error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

router.get('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const session = await liveCtrl.getLiveSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, session });
  } catch (err) {
    console.error('live.session error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// POST /api/live/create { hostId, hostDisplayName? }
router.post('/create', async (req, res) => {
  const { hostId, hostDisplayName } = req.body || {};
  if (!hostId) return res.status(400).json({ ok: false, error: 'missing hostId' });
  try {
    const live = await liveCtrl.createLive(hostId, hostDisplayName);
    const session = liveCtrl.buildSession(live, []);
    broadcast(req.app.get('io'), 'live_started', { session });
    res.json({ ok: true, data: live, session });
  } catch (err) {
    const msg = err?.message || err?.error_description || String(err);
    console.error('live.create error', msg);
    if (msg.includes('not configured') || msg.includes('Supabase')) {
      return res.status(503).json({ ok: false, error: 'Live streaming is not available (database not configured)' });
    }
    if (msg.includes('must end your current live')) {
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

// POST /api/live/:id/end  body: { creatorId? } — creatorId required when verifying host
router.post('/:id/end', async (req, res) => {
  const { id } = req.params;
  const { creatorId } = req.body || {};
  try {
    const payout = await liveCtrl.endLive(id, { requesterId: creatorId != null ? creatorId : undefined });
    const io = req.app.get('io');
    emitToLive(io, id, 'live_ended', { sessionId: id, payout });
    emitToLive(io, id, 'live-ended', payout);
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
