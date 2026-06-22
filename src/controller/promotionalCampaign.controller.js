import {
  getActivePromotionalCampaigns,
  hashIp,
  hashVisitor,
  recordPromotionalCampaignEvent,
} from '../services/promotionalCampaign.service.js';

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function clientSessionId(req) {
  return (
    req.body?.sessionId ||
    req.body?.session_id ||
    req.headers['x-session-id'] ||
    req.headers['x-client-session-id'] ||
    null
  );
}

function publicCampaign(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    image_url: row.image_url,
    video_url: row.video_url,
    cta_text: row.cta_text,
    cta_link: row.cta_link,
    priority: row.priority,
    start_date: row.start_date,
    end_date: row.end_date,
  };
}

export async function listActiveCampaigns(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit || '3', 10) || 3, 1), 10);
    const result = await getActivePromotionalCampaigns({ limit });
    res.set('Cache-Control', 'no-store');
    return res.json({
      campaigns: result.campaigns.map(publicCampaign),
      schemaReady: result.schemaReady,
    });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to load promotional campaigns' });
  }
}

async function recordEvent(req, res, eventType) {
  try {
    const campaignId = req.params.id;
    if (!campaignId) return res.status(400).json({ message: 'campaign id is required' });
    const sessionId = clientSessionId(req);
    const userId = req.uid || req.user?.id || req.body?.userId || null;
    const userAgent = String(req.headers['user-agent'] || '');
    const ip = clientIp(req);
    const viewerHash = hashVisitor({ userId, sessionId, ip, userAgent });
    const result = await recordPromotionalCampaignEvent({
      campaignId,
      eventType,
      viewerHash,
      userId,
      sessionId,
      ipHash: hashIp(ip),
      userAgent,
      metadata: {
        path: req.body?.path || req.headers.referer || null,
        campaignId,
      },
    });
    return res.json(result);
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || 'Failed to record promotional campaign event' });
  }
}

export function recordImpression(req, res) {
  return recordEvent(req, res, 'impression');
}

export function recordClick(req, res) {
  return recordEvent(req, res, 'click');
}

export function recordClose(req, res) {
  return recordEvent(req, res, 'close');
}
