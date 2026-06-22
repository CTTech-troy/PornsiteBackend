import express from 'express';
import rateLimit from 'express-rate-limit';
import { getFollowStatus, getPublicProfile, toggleCreatorFollow } from '../config/dbFallback.js';
import { optionalAuth, requireAuth } from '../middleware/authFirebase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import { invalidateTopCreatorsCache } from '../services/creatorLeaderboard.service.js';
import { recordAnalyticsEngagement } from '../services/analytics.service.js';
import { emitPlatformActivity } from '../services/platformActivity.service.js';

const router = express.Router();

const followLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: Number(process.env.USER_FOLLOW_MAX_PER_10S || 10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('users:follows'),
  message: { ok: false, error: 'Too many follow actions. Please slow down.' },
});

// GET /api/users/:id - public profile.
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const profile = await getPublicProfile(id);
    if (!profile) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, data: profile });
  } catch (err) {
    console.error('users.get error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// GET /api/users/:id/follow-status - current viewer follow state.
router.get('/:id/follow-status', optionalAuth, async (req, res) => {
  const { id: creatorId } = req.params;
  try {
    const result = await getFollowStatus(req.uid || null, creatorId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('users.followStatus error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// POST /api/users/:id/follow - toggle the signed-in user's creator follow.
router.post('/:id/follow', requireAuth, followLimiter, async (req, res) => {
  const { id: creatorId } = req.params;
  try {
    if (String(req.uid) === String(creatorId)) {
      return res.status(400).json({ ok: false, error: 'You cannot follow yourself.' });
    }
    const result = await toggleCreatorFollow(req.uid, creatorId);
    invalidateTopCreatorsCache();
    recordAnalyticsEngagement({
      eventType: result?.subscribed ? 'creator_follow' : 'creator_unfollow',
      creatorId,
      userId: req.uid,
    }).catch(() => {});
    emitPlatformActivity(req.app?.get?.('io'), result?.subscribed ? 'creator_follow' : 'creator_unfollow', {
      actorId: req.uid,
      targetType: 'creator',
      targetId: creatorId,
      payload: { creatorId, userId: req.uid, subscribed: result?.subscribed === true },
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('users.follow error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

// DELETE /api/users/:id/follow - force unfollow without toggling back on.
router.delete('/:id/follow', requireAuth, followLimiter, async (req, res) => {
  const { id: creatorId } = req.params;
  try {
    const current = await getFollowStatus(req.uid, creatorId);
    let result = current;
    if (current.subscribed) {
      result = await toggleCreatorFollow(req.uid, creatorId);
      invalidateTopCreatorsCache();
      recordAnalyticsEngagement({
        eventType: 'creator_unfollow',
        creatorId,
        userId: req.uid,
      }).catch(() => {});
      emitPlatformActivity(req.app?.get?.('io'), 'creator_unfollow', {
        actorId: req.uid,
        targetType: 'creator',
        targetId: creatorId,
        payload: { creatorId, userId: req.uid, subscribed: false },
      });
    }
    res.json({ ok: true, ...result, subscribed: false });
  } catch (err) {
    console.error('users.unfollow error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

export default router;
