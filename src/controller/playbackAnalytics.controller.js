import { supabase } from '../config/supabase.js';
import { isMissingDbFeature } from '../services/revenueCalculation.service.js';

const ALLOWED_EVENTS = new Set([
  'play_start',
  'playing',
  'buffer_start',
  'buffer_end',
  'quality_change',
  'stream_retry',
  'playback_error',
  'ended',
  'watch_progress',
]);

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function trimValue(value, max = 160) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

async function touchPlayHistory({ videoId, userId, fingerprint }) {
  if (!supabase || !videoId || (!userId && !fingerprint)) return;
  const now = new Date().toISOString();

  try {
    let query = supabase.from('video_play_history').select('id');
    if (userId) {
      query = query.eq('video_id', videoId).eq('user_id', userId);
    } else {
      query = query.eq('video_id', videoId).eq('session_id', fingerprint);
    }
    const { data, error } = await query.maybeSingle();
    if (error && isMissingDbFeature(error)) return;
    if (error) return;

    if (data?.id) {
      await supabase.from('video_play_history').update({ updated_at: now }).eq('id', data.id);
      return;
    }

    const row = userId
      ? { video_id: videoId, user_id: userId, has_seen_ad: false, updated_at: now }
      : { video_id: videoId, session_id: fingerprint, has_seen_ad: false, updated_at: now };
    await supabase.from('video_play_history').insert(row);
  } catch {
    /* analytics must never block playback */
  }
}

export async function recordPlaybackEvent(req, res) {
  try {
    const body = req.body || {};
    const videoId = trimValue(body.videoId || body.video_id || body.id, 160);
    const event = String(body.event || body.eventType || '').trim().toLowerCase();
    const fingerprint = trimValue(body.fingerprint, 200);

    if (!videoId) return res.status(400).json({ success: false, message: 'videoId required' });
    if (!ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ success: false, message: 'Invalid playback event' });
    }

    if (['play_start', 'playing', 'watch_progress'].includes(event)) {
      await touchPlayHistory({ videoId, userId: req.uid || null, fingerprint });
    }

    if (supabase) {
      const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
      const { error } = await supabase.from('playback_performance_events').insert({
        video_id: videoId,
        user_id: req.uid || null,
        fingerprint: fingerprint || null,
        event_type: event,
        current_time: asNumber(body.currentTime ?? body.current_time),
        duration: asNumber(body.duration),
        quality_label: trimValue(body.quality || body.qualityLabel || body.quality_label, 40),
        buffering_ms: asNumber(body.bufferingMs ?? body.buffering_ms),
        stream_type: trimValue(body.streamType || body.stream_type, 40),
        error_kind: trimValue(body.errorKind || body.error_kind, 60),
        metadata: {
          ...metadata,
          connection: body.connection || null,
          viewport: body.viewport || null,
          userAgent: trimValue(req.get('user-agent'), 220),
        },
      });
      if (error && !isMissingDbFeature(error)) {
        console.warn('[playbackAnalytics] insert failed:', error.message || error);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.warn('[playbackAnalytics] recordPlaybackEvent:', err?.message || err);
    return res.json({ success: true, recoverable: true });
  }
}
