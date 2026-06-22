import {
  recordAnalyticsHeartbeat,
  recordAnalyticsEngagement,
  recordAnalyticsPageView,
  recordAnalyticsSessionEnd,
  recordAnalyticsVideoWatch,
  recordAnalyticsVisit,
} from '../services/analytics.service.js';

function ok(res, result) {
  return res.json({ success: true, ...result });
}

export async function postVisit(req, res) {
  try {
    return ok(res, await recordAnalyticsVisit(req, req.body || {}));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}

export async function postPageView(req, res) {
  try {
    return ok(res, await recordAnalyticsPageView(req, req.body || {}));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}

export async function postHeartbeat(req, res) {
  try {
    return ok(res, await recordAnalyticsHeartbeat(req, req.body || {}));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}

export async function postSessionEnd(req, res) {
  try {
    return ok(res, await recordAnalyticsSessionEnd(req, req.body || {}));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}

export async function postVideoWatch(req, res) {
  try {
    return ok(res, await recordAnalyticsVideoWatch(req, req.body || {}));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}

export async function postEngagement(req, res) {
  try {
    const body = req.body || {};
    return ok(res, await recordAnalyticsEngagement({
      eventType: body.eventType || body.event_type,
      videoId: body.videoId || body.video_id,
      creatorId: body.creatorId || body.creator_id,
      userId: req?.uid || body.userId || body.user_id,
      sessionId: body.sessionId || body.session_id,
      value: body.value,
      metadata: body.metadata || {},
    }));
  } catch {
    return ok(res, { recorded: false, recoverable: true });
  }
}
