import express from 'express';
import {
  getVideoInfo,
  searchVideos,
  searchByCategory,
  getModelInfo,
} from '../../pornhubScraper.js';

const router = express.Router();

router.get('/video-info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  try {
    const data = await getVideoInfo(url);
    res.json(data);
  } catch (err) {
    console.error('Pornhub video-info error', err);
    res.status(500).json({ error: 'Failed to fetch video info' });
  }
});

router.get('/search', async (req, res) => {
  const { q, page, sort } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing q query parameter' });
  }

  try {
    const data = await searchVideos(q, {
      page: page ? Number(page) : 1,
      sort: sort || 'mr',
    });
    res.json(data);
  } catch (err) {
    console.error('Pornhub search error', err);
    res.status(500).json({ error: 'Failed to perform search' });
  }
});

router.get('/category', async (req, res) => {
  const { category, page, ...filters } = req.query;

  if (!category) {
    return res.status(400).json({ error: 'Missing category query parameter' });
  }

  try {
    const data = await searchByCategory({
      category,
      page: page ? Number(page) : 1,
      filters,
    });
    res.json(data);
  } catch (err) {
    console.error('Pornhub category error', err);
    res.status(500).json({ error: 'Failed to perform category search' });
  }
});

router.get('/model', async (req, res) => {
  const { name, type } = req.query;

  if (!name) {
    return res.status(400).json({ error: 'Missing name query parameter' });
  }

  try {
    const data = await getModelInfo(name, type || 'pornstar');
    res.json(data);
  } catch (err) {
    console.error('Pornhub model error', err);
    res.status(500).json({ error: 'Failed to fetch model info' });
  }
});

export default router;

