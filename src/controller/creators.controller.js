/**
 * Creators: list (from pornstars API, sorted by rankingScore) and detail (from scraper API).
 */
import { fetchPornstars } from './star.controller.js';

const SCRAPER_CACHE = new Map();
const SCRAPER_CACHE_TTL = 10 * 60 * 1000; // 10 min

function slugify(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'creator';
}

/** Extract model slug from Pornhub model URL or link. */
function slugFromLink(link) {
  if (!link || typeof link !== 'string') return '';
  const m = link.match(/\/model\/([^/?]+)/i);
  return m ? m[1] : '';
}

/**
 * GET list: use pornstars API, add id/slug and rankingScore, sort descending.
 */
export async function getCreatorsList(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
    const raw = await fetchPornstars(limit);
    const list = (Array.isArray(raw) ? raw : []).map((s, index) => {
      const name = s.star_name || s.name || '';
      const link = s.link || s.url || s.profile_url || '';
      const slug = slugFromLink(link) || slugify(name) || `c-${index}`;
      const rankingScore = Number(s.ranking_score ?? s.videos_count_all ?? s.views ?? s.rank ?? 0) || 0;
      return {
        id: slug,
        slug,
        name,
        star_name: name,
        avatar: s.star_thumb || s.thumb || s.avatar || '',
        videosCount: Number(s.videos_count_all ?? s.videos_count ?? 0) || 0,
        rankingScore,
        link: link || `https://www.pornhub.com/model/${slug}/videos`,
      };
    });
    list.sort((a, b) => (b.rankingScore || 0) - (a.rankingScore || 0));
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('creators.getCreatorsList', err?.message || err);
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
}

/**
 * GET creator by slug: fetch profile + videos from scraper API.
 */
export async function getCreatorBySlug(req, res) {
  const slug = (req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ success: false, error: 'Creator slug required' });

  const cacheKey = `slug:${slug}`;
  const cached = SCRAPER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCRAPER_CACHE_TTL) {
    return res.json({ success: true, data: cached.data });
  }

  const key = process.env.RAPIDAPI_SCRAPER_KEY;
  const host = process.env.RAPIDAPI_SCRAPER_HOST;
  const baseUrl = process.env.RAPIDAPI_SCRAPER_URL || `https://${host}/api/pornhub/pornstar`;
  const apiKey = process.env.RAPIDAPI_SCRAPER_API_KEY;

  if (!key || !host) {
    return res.status(503).json({ success: false, error: 'Scraper API not configured' });
  }

  const modelUrl = `https://www.pornhub.com/model/${encodeURIComponent(slug)}/videos`;
  const url = `${baseUrl}?url=${encodeURIComponent(modelUrl)}&page=1`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const headers = {
      'x-rapidapi-key': key,
      'x-rapidapi-host': host,
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const resFetch = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resFetch.ok) {
      if (resFetch.status === 429) return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
      return res.status(resFetch.status).json({ success: false, error: 'Scraper request failed' });
    }

    const json = await resFetch.json();
    const profile = json.profile || json.data?.profile || json.model || json.data?.model || {};
    const videosRaw = json.videos ?? json.data?.videos ?? json.results ?? [];
    const videos = Array.isArray(videosRaw) ? videosRaw : [];

    const data = {
      id: slug,
      slug,
      name: profile.name || profile.star_name || profile.username || slug,
      avatar: profile.avatar || profile.star_thumb || profile.thumb || profile.image || '',
      bio: profile.bio || profile.description || '',
      videosCount: profile.videos_count ?? profile.videosCount ?? videos.length,
      videos: videos.map((v, i) => ({
        id: v.id || v.video_id || v.key || `v-${i}`,
        title: v.title || v.name || '',
        thumbnail: v.thumbnail || v.thumb || v.poster || '',
        duration: v.duration ?? v.length ?? 0,
        views: v.views ?? v.views_count ?? 0,
        url: v.url || v.link || '',
      })),
    };

    SCRAPER_CACHE.set(cacheKey, { ts: Date.now(), data });
    return res.json({ success: true, data });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return res.status(504).json({ success: false, error: 'Scraper timeout' });
    }
    console.error('creators.getCreatorBySlug', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}
