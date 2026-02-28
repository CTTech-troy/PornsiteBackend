import express from 'express';
import { getPublicProfile, incrementFollow } from '../config/dbFallback.js';

const router = express.Router();

// GET /api/users/:id — public profile (displayName, followers)
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

// POST /api/users/:id/follow — increment creator's followers count
router.post('/:id/follow', async (req, res) => {
  const { id: creatorId } = req.params;
  try {
    const result = await incrementFollow(creatorId);
    res.json({ ok: true, followers: result.followers });
  } catch (err) {
    console.error('users.follow error', err && err.message ? err.message : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

export default router;
