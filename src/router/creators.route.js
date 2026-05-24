import express from 'express';
import { getCreatorsList, getCreatorBySlug } from '../controller/creators.controller.js';
import { getCreatorsByType, getTopPlatformCreators } from '../controller/creators.controller.js';

const router = express.Router();

// GET /api/creators — list all external creators, sorted by rankingScore desc
router.get('/', getCreatorsList);

// GET /api/creators/top?limit=5 — top platform creators with real avatars + video counts
router.get('/top', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 100);
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const result = await getTopPlatformCreators({ limit, page });
    return res.json({
      success: true,
      data: result.creators || [],
      total: result.total || 0,
      page: result.page || page,
      limit: result.limit || limit,
      cached: result.cached === true,
      generatedAt: result.generatedAt,
      source: result.source,
    });
  } catch (err) {
    console.error('creators.top', err?.message || err);
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
});

// GET /api/creators/platform?type=channel|pstar&limit=100
// MUST be registered before /:slug to avoid "platform" matching as a slug
router.get('/platform', async (req, res) => {
  try {
    const type = req.query.type === 'channel' ? 'channel' : 'pstar';
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
    const data = await getCreatorsByType(type, limit);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('creators.platform', err?.message || err);
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
});

// GET /api/creators/:slug — profile + videos for one creator
router.get('/:slug', getCreatorBySlug);

export default router;
