import {
  getAnalyticsOverview,
  getRealtimeAnalytics,
  refreshAnalyticsDailySummary,
} from '../services/analytics.service.js';

export async function getOverview(req, res) {
  try {
    const payload = await getAnalyticsOverview(req.query || {});
    return res.json({ success: true, ...payload });
  } catch (err) {
    console.error('adminAnalytics.getOverview', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to load analytics' });
  }
}

export async function getRealtime(req, res) {
  try {
    const realtime = await getRealtimeAnalytics();
    return res.json({ success: true, realtime });
  } catch (err) {
    console.error('adminAnalytics.getRealtime', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to load realtime analytics' });
  }
}

export async function postRefreshSummary(req, res) {
  try {
    const result = await refreshAnalyticsDailySummary({ ...req.query, ...(req.body || {}) });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('adminAnalytics.postRefreshSummary', err?.message || err);
    return res.status(500).json({ success: false, message: err?.message || 'Failed to refresh analytics summary' });
  }
}
