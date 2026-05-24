import { supabase } from '../config/supabase.js';
import { incrementProviderStats } from './adProvider.service.js';

function isMissingTable(err) {
  const msg = String(err?.message || err?.code || '');
  return msg.includes('does not exist') || err?.code === '42P01' || err?.code === 'PGRST205';
}

export async function recordMonitoringEvent(event) {
  if (!supabase) return null;
  const row = {
    provider_id: event.providerId || null,
    zone_id: event.zoneId || null,
    session_id: event.sessionId || null,
    video_id: event.videoId || null,
    user_id: event.userId || null,
    fingerprint: event.fingerprint || null,
    event_type: event.eventType,
    placement: event.placement || null,
    device_type: event.deviceType || null,
    browser: event.browser || null,
    country: event.country || null,
    revenue_usd: Number(event.revenueUsd || 0),
    metadata: event.metadata || {},
  };

  const { data, error } = await supabase.from('ad_monitoring_events').insert(row).select('id').maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      console.warn('[ad-monitoring] ad_monitoring_events table missing; event accepted without persistence', {
        eventType: row.event_type,
        providerId: row.provider_id,
      });
      return null;
    }
    throw error;
  }

  const isImpression = ['impression', 'started', 'request'].includes(event.eventType);
  const isClick = event.eventType === 'click';
  const isFailure = ['error', 'timeout', 'empty_vast', 'blocked', 'adblock'].includes(event.eventType);

  if (event.providerId) {
    try {
      await incrementProviderStats(event.providerId, {
        impressions: isImpression ? 1 : 0,
        clicks: isClick ? 1 : 0,
        failed: isFailure ? 1 : 0,
        revenueUsd: Number(event.revenueUsd || 0),
        success: isFailure ? false : isImpression ? true : null,
      });
    } catch (err) {
      console.warn('[ad-monitoring] provider stats update failed; event was accepted', {
        providerId: event.providerId,
        eventType: event.eventType,
        message: err?.message || String(err),
        code: err?.code,
      });
    }
  }

  return data?.id || null;
}

export async function getMonitoringOverview(range = '24h') {
  const since = rangeToSince(range);
  const empty = {
    impressions: 0,
    completions: 0,
    skips: 0,
    errors: 0,
    clicks: 0,
    adblock: 0,
    emptyInventory: 0,
    timeouts: 0,
    fillRate: 0,
    ctr: 0,
    completionRate: 0,
    skipRate: 0,
    revenueUsd: 0,
    sessions: 0,
  };

  if (!supabase) return empty;

  const [eventsRes, vastSessionsRes, vastEventsRes] = await Promise.all([
    supabase.from('ad_monitoring_events').select('event_type,revenue_usd,provider_id').gte('created_at', since),
    supabase.from('vast_ad_sessions').select('id,status').gte('started_at', since),
    supabase.from('vast_ad_events').select('event_type').gte('created_at', since),
  ]);

  const events = eventsRes.data || [];
  const vastSessions = vastSessionsRes.data || [];
  const vastEvents = vastEventsRes.data || [];

  const counts = { ...empty };
  for (const e of events) {
    counts.revenueUsd += Number(e.revenue_usd || 0);
    if (['impression', 'started', 'request'].includes(e.event_type)) counts.impressions += 1;
    if (e.event_type === 'complete') counts.completions += 1;
    if (e.event_type === 'skip') counts.skips += 1;
    if (e.event_type === 'click') counts.clicks += 1;
    if (e.event_type === 'error') counts.errors += 1;
    if (e.event_type === 'adblock') counts.adblock += 1;
    if (e.event_type === 'empty_vast') counts.emptyInventory += 1;
    if (e.event_type === 'timeout') counts.timeouts += 1;
  }

  for (const e of vastEvents) {
    if (e.event_type === 'impression' || e.event_type === 'started') counts.impressions += 1;
    if (e.event_type === 'complete') counts.completions += 1;
    if (e.event_type === 'skip') counts.skips += 1;
    if (e.event_type === 'click') counts.clicks += 1;
    if (e.event_type === 'error') counts.errors += 1;
  }

  counts.sessions = vastSessions.length + new Set(events.map((e) => e.session_id).filter(Boolean)).size;
  const requests = counts.impressions + counts.errors + counts.emptyInventory + counts.timeouts;
  counts.fillRate = requests ? ((counts.impressions / requests) * 100) : 0;
  counts.ctr = counts.impressions ? ((counts.clicks / counts.impressions) * 100) : 0;
  const plays = counts.completions + counts.skips;
  counts.completionRate = plays ? ((counts.completions / plays) * 100) : 0;
  counts.skipRate = plays ? ((counts.skips / plays) * 100) : 0;

  return counts;
}

export async function getRecentEvents(limit = 100) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('ad_monitoring_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

export async function getSessionTimeline(sessionId) {
  if (!supabase || !sessionId) return [];
  const [monitoring, vast] = await Promise.all([
    supabase.from('ad_monitoring_events').select('*').eq('session_id', sessionId).order('created_at'),
    supabase.from('vast_ad_events').select('*').eq('session_id', sessionId).order('created_at'),
  ]);
  const items = [
    ...(monitoring.data || []).map((r) => ({ source: 'monitoring', ...r })),
    ...(vast.data || []).map((r) => ({ source: 'vast', event_type: r.event_type, created_at: r.created_at, metadata: r.metadata })),
  ];
  return items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export async function getProviderAnalytics(range = '30d') {
  const since = rangeToSince(range);
  if (!supabase) return [];

  const { data: providers } = await supabase.from('ad_providers').select('*').order('priority');
  const { data: events } = await supabase
    .from('ad_monitoring_events')
    .select('provider_id,event_type,revenue_usd')
    .gte('created_at', since);

  const { data: vastEvents } = await supabase
    .from('vast_ad_events')
    .select('session_id,event_type')
    .gte('created_at', since);

  const vastByProvider = {};
  if (vastEvents?.length) {
    const { data: sessions } = await supabase
      .from('vast_ad_sessions')
      .select('id,vast_tag_url')
      .gte('started_at', since);
    const exoSessions = (sessions || []).filter((s) => String(s.vast_tag_url || '').includes('magsrv'));
    vastByProvider.exoclick = exoSessions.length;
  }

  return (providers || []).map((p) => {
    const pe = (events || []).filter((e) => e.provider_id === p.id);
    const impressions = pe.filter((e) => ['impression', 'started', 'request'].includes(e.event_type)).length;
    const clicks = pe.filter((e) => e.event_type === 'click').length;
    const errors = pe.filter((e) => ['error', 'timeout', 'empty_vast', 'blocked'].includes(e.event_type)).length;
    const revenue = pe.reduce((s, e) => s + Number(e.revenue_usd || 0), 0) + Number(p.revenue_usd || 0);
    const requests = impressions + errors;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      type: p.provider_type,
      isEnabled: p.is_enabled,
      isMaintenance: p.is_maintenance,
      healthStatus: p.last_health_status,
      lastSuccessAt: p.last_success_at,
      lastFailureAt: p.last_failure_at,
      impressions: impressions + (p.id === 'exoclick' ? (vastByProvider.exoclick || 0) : 0),
      clicks,
      failedRequests: errors + Number(p.failed_requests || 0),
      revenueUsd: revenue,
      fillRate: requests ? (impressions / requests) * 100 : 0,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cpm: impressions ? (revenue / impressions) * 1000 : Number(p.estimated_cpm_usd || 0),
    };
  });
}

export async function getDailyAnalytics(range = '30d') {
  const since = rangeToSince(range);
  if (!supabase) return [];
  const { data } = await supabase
    .from('ad_monitoring_events')
    .select('created_at,event_type,revenue_usd')
    .gte('created_at', since)
    .order('created_at');
  const byDay = {};
  for (const row of data || []) {
    const day = String(row.created_at).slice(0, 10);
    if (!byDay[day]) byDay[day] = { date: day, impressions: 0, clicks: 0, errors: 0, revenueUsd: 0 };
    if (['impression', 'started', 'request'].includes(row.event_type)) byDay[day].impressions += 1;
    if (row.event_type === 'click') byDay[day].clicks += 1;
    if (['error', 'timeout', 'empty_vast'].includes(row.event_type)) byDay[day].errors += 1;
    byDay[day].revenueUsd += Number(row.revenue_usd || 0);
  }
  return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
}

function rangeToSince(range) {
  const ms = {
    '1h': 3600_000,
    '24h': 86400_000,
    '7d': 7 * 86400_000,
    '30d': 30 * 86400_000,
    '90d': 90 * 86400_000,
  };
  return new Date(Date.now() - (ms[range] || ms['24h'])).toISOString();
}
