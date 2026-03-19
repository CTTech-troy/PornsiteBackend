/**
 * GET /api/videos/todays-selection
 * Proxies RapidAPI xnxx-api /xn/todays-selection.
 */
import { ingestHomeFeedVideos } from '../config/homeFeedCache.js';
import { isXnxxApiConfigured, fetchXnxxTodaysSelection } from '../utils/xnxxRapidApi.js';

export async function getTodaysSelection(req, res) {
  if (!isXnxxApiConfigured()) {
    return res.status(503).json({
      success: false,
      data: [],
      error: 'XNXX API not configured. Set RAPIDAPI_XNXX_API_KEY in backend .env',
    });
  }
  const { ok, items, status, raw, error } = await fetchXnxxTodaysSelection();
  if (!ok) {
    console.warn('[todays-selection] upstream', status, typeof raw === 'string' ? raw.slice(0, 200) : raw);
    return res.status(status >= 400 ? status : 502).json({
      success: false,
      data: [],
      error: typeof raw === 'string' ? raw.slice(0, 200) : error || 'Upstream error',
    });
  }
  ingestHomeFeedVideos(items);
  console.log('Video API Response: todays-selection', { count: items.length });
  return res.json({ success: true, data: items, hasMore: false });
}
