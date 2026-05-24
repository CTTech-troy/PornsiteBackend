import {
  createAdSession,
  recordAdEvent,
  getAdStatusForVideo,
} from '../services/vastAdSession.service.js';
import { getVastAdMetrics } from '../services/vastAdAnalytics.service.js';
import { resolveRange } from '../services/revenueCalculation.service.js';

export async function postAdSession(req, res) {
  try {
    const videoId = String(req.params.id || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: 'Video id required' });

    const { fingerprint, skipAds } = req.body || {};
    const data = await createAdSession({
      videoId,
      userId: req.uid || null,
      fingerprint: fingerprint || null,
      skipAds: Boolean(skipAds),
    });

    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[vastAd] postAdSession:', err.message);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Failed to create ad session' });
  }
}

export async function postAdEventHandler(req, res) {
  try {
    const videoId = String(req.params.id || '').trim();
    const { sessionId, event, metadata } = req.body || {};
    if (!videoId || !sessionId || !event) {
      return res.status(400).json({ success: false, message: 'sessionId and event required' });
    }

    const result = await recordAdEvent({
      sessionId,
      event,
      metadata: { ...(metadata || {}), videoId },
      userId: req.uid || null,
      fingerprint: req.body?.fingerprint || null,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[vastAd] postAdEvent:', err.message);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Failed to record ad event' });
  }
}

export async function getAdStatus(req, res) {
  try {
    const videoId = String(req.params.id || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: 'Video id required' });

    const fingerprint = req.query.fingerprint || null;
    const data = await getAdStatusForVideo({
      videoId,
      userId: req.uid || null,
      fingerprint,
    });

    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[vastAd] getAdStatus:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
}

export async function getStudioVastAnalytics(req, res) {
  try {
    const uid = req.uid;
    const { from, to } = resolveRange(req.query || {});
    const metrics = await getVastAdMetrics({ creatorId: uid, from, to });
    return res.json({ success: true, data: metrics });
  } catch (err) {
    console.error('[vastAd] getStudioVastAnalytics:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
}

export async function getAdminVastAnalytics(req, res) {
  try {
    const { from, to } = resolveRange(req.query || {});
    const metrics = await getVastAdMetrics({ from, to });
    return res.json({ success: true, data: metrics });
  } catch (err) {
    console.error('[vastAd] getAdminVastAnalytics:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed' });
  }
}
