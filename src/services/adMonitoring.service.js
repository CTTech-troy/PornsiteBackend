import { supabase } from '../config/supabase.js';
import { incrementProviderStats } from './adProvider.service.js';

const KNOWN_PROVIDER_IDS = new Set(['exoclick', 'juicyads', 'monetag', 'google_ad_manager']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingTable(err) {
  const msg = String(err?.message || err?.code || '');
  return (
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    err?.code === 'PGRST204' ||
    err?.code === 'PGRST205'
  );
}

function isInvalidReferenceInput(err) {
  return err?.code === '22P02' || err?.code === '23503';
}

function cleanText(value, maxLength = 255) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maxLength);
}

function isUuid(value) {
  return UUID_PATTERN.test(cleanText(value));
}

function normalizeProviderId(value) {
  const providerId = cleanText(value, 80).toLowerCase();
  return KNOWN_PROVIDER_IDS.has(providerId) ? providerId : null;
}

function isLikelyExternalZoneId(value) {
  return /^\d{3,}$/.test(cleanText(value, 80));
}

function normalizeMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) return { ...metadata };
  return { value: metadata };
}

async function resolveAdZoneRecordId({ providerId, zoneId, placement }) {
  const cleanZoneId = cleanText(zoneId, 120);
  if (!supabase || !cleanZoneId) return null;
  if (isUuid(cleanZoneId)) return cleanZoneId;

  try {
    let query = supabase
      .from('ad_zones')
      .select('id,provider_id,placement,zone_id')
      .eq('zone_id', cleanZoneId)
      .limit(10);

    if (providerId) query = query.eq('provider_id', providerId);

    const { data, error } = await query;
    if (error) {
      if (!isMissingTable(error)) {
        console.warn('[ad-monitoring] ad zone lookup failed; storing event without zone relation', {
          providerId,
          zoneId: cleanZoneId,
          message: error.message || String(error),
          code: error.code,
        });
      }
      return null;
    }

    const zones = data || [];
    const matched = zones.find((zone) => !placement || zone.placement === placement) || zones[0];
    return isUuid(matched?.id) ? matched.id : null;
  } catch (err) {
    console.warn('[ad-monitoring] ad zone lookup failed; storing event without zone relation', {
      providerId,
      zoneId: cleanZoneId,
      message: err?.message || String(err),
      code: err?.code,
    });
    return null;
  }
}

async function insertMonitoringRow(row) {
  const { data, error } = await supabase.from('ad_monitoring_events').insert(row).select('id').maybeSingle();
  if (!error) return data?.id || null;

  if (isMissingTable(error)) {
    console.warn('[ad-monitoring] monitoring table/schema unavailable; event accepted without persistence', {
      eventType: row.event_type,
      providerId: row.provider_id,
      message: error.message || String(error),
      code: error.code,
    });
    return null;
  }

  if (isInvalidReferenceInput(error) && (row.provider_id || row.zone_id)) {
    const retryRow = {
      ...row,
      provider_id: null,
      zone_id: null,
      metadata: {
        ...(row.metadata || {}),
        droppedProviderId: row.provider_id || undefined,
        droppedZoneRecordId: row.zone_id || undefined,
        storageWarning: error.code === '22P02' ? 'invalid_uuid_reference' : 'missing_provider_or_zone_reference',
      },
    };
    const retry = await supabase.from('ad_monitoring_events').insert(retryRow).select('id').maybeSingle();
    if (!retry.error) return retry.data?.id || null;
    if (isMissingTable(retry.error)) return null;
    throw retry.error;
  }

  throw error;
}

export async function recordMonitoringEvent(event) {
  if (!supabase) return null;
  const metadata = normalizeMetadata(event.metadata);
  const rawProviderId = cleanText(event.providerId, 80);
  const providerId = normalizeProviderId(rawProviderId);
  const rawZoneId = cleanText(event.zoneId || metadata.zoneId || metadata.zone_id || '', 120);
  const externalZoneId = !isUuid(rawZoneId)
    ? (rawZoneId || (isLikelyExternalZoneId(rawProviderId) ? rawProviderId : ''))
    : cleanText(metadata.externalZoneId || metadata.external_zone_id || '', 120);
  const placement = cleanText(event.placement, 120) || null;
  const zoneRecordId = await resolveAdZoneRecordId({
    providerId,
    zoneId: rawZoneId,
    placement,
  });
  const eventMetadata = {
    ...metadata,
    ...(externalZoneId ? { externalZoneId } : {}),
    ...(rawZoneId ? { rawZoneId } : {}),
    ...(rawProviderId && rawProviderId !== providerId ? { rawProviderId } : {}),
  };
  const row = {
    provider_id: providerId,
    zone_id: zoneRecordId,
    session_id: cleanText(event.sessionId, 160) || null,
    video_id: cleanText(event.videoId, 160) || null,
    user_id: cleanText(event.userId, 160) || null,
    fingerprint: cleanText(event.fingerprint, 255) || null,
    event_type: cleanText(event.eventType, 80) || 'diagnostic',
    placement,
    device_type: cleanText(event.deviceType, 80) || null,
    browser: cleanText(event.browser, 120) || null,
    country: cleanText(event.country, 8) || null,
    revenue_usd: Number(event.revenueUsd || 0),
    metadata: eventMetadata,
  };

  const id = await insertMonitoringRow(row);

  const isImpression = ['impression', 'started', 'request'].includes(row.event_type);
  const isClick = row.event_type === 'click';
  const isFailure = ['error', 'timeout', 'empty_vast', 'blocked', 'adblock'].includes(row.event_type);

  if (providerId) {
    try {
      await incrementProviderStats(providerId, {
        impressions: isImpression ? 1 : 0,
        clicks: isClick ? 1 : 0,
        failed: isFailure ? 1 : 0,
        revenueUsd: Number(event.revenueUsd || 0),
        success: isFailure ? false : isImpression ? true : null,
      });
    } catch (err) {
      console.warn('[ad-monitoring] provider stats update failed; event was accepted', {
        providerId,
        eventType: row.event_type,
        message: err?.message || String(err),
        code: err?.code,
      });
    }
  }

  return id;
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
    supabase.from('ad_monitoring_events').select('event_type,revenue_usd,provider_id,session_id').gte('created_at', since),
    supabase.from('vast_ad_sessions').select('id,status').gte('started_at', since),
    supabase.from('vast_ad_events').select('event_type').gte('created_at', since),
  ]);

  if (eventsRes.error && !isMissingTable(eventsRes.error)) throw eventsRes.error;
  if (vastSessionsRes.error && !isMissingTable(vastSessionsRes.error)) throw vastSessionsRes.error;
  if (vastEventsRes.error && !isMissingTable(vastEventsRes.error)) throw vastEventsRes.error;

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
    if (e.event_type === 'empty_vast' || e.event_type === 'no_fill') counts.emptyInventory += 1;
    if (e.event_type === 'timeout') counts.timeouts += 1;
  }

  for (const e of vastEvents) {
    if (e.event_type === 'impression' || e.event_type === 'started') counts.impressions += 1;
    if (e.event_type === 'complete') counts.completions += 1;
    if (e.event_type === 'skip') counts.skips += 1;
    if (e.event_type === 'click') counts.clicks += 1;
    if (e.event_type === 'error') counts.errors += 1;
    if (e.event_type === 'no_fill') counts.emptyInventory += 1;
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
  if (monitoring.error && !isMissingTable(monitoring.error)) throw monitoring.error;
  if (vast.error && !isMissingTable(vast.error)) throw vast.error;
  const items = [
    ...(monitoring.data || []).map((r) => ({ source: 'monitoring', ...r })),
    ...(vast.data || []).map((r) => ({ source: 'vast', event_type: r.event_type, created_at: r.created_at, metadata: r.metadata })),
  ];
  return items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export async function getProviderAnalytics(range = '30d') {
  const since = rangeToSince(range);
  if (!supabase) return [];

  const { data: providers, error: providersError } = await supabase.from('ad_providers').select('*').order('priority');
  if (providersError) {
    if (isMissingTable(providersError)) return [];
    throw providersError;
  }
  const { data: events, error: eventsError } = await supabase
    .from('ad_monitoring_events')
    .select('provider_id,event_type,revenue_usd')
    .gte('created_at', since);
  if (eventsError && !isMissingTable(eventsError)) throw eventsError;

  const { data: vastEvents, error: vastEventsError } = await supabase
    .from('vast_ad_events')
    .select('session_id,event_type')
    .gte('created_at', since);
  if (vastEventsError && !isMissingTable(vastEventsError)) throw vastEventsError;

  const vastByProvider = {};
  if (vastEvents?.length) {
    const { data: sessions, error: sessionsError } = await supabase
      .from('vast_ad_sessions')
      .select('id,vast_tag_url')
      .gte('started_at', since);
    if (sessionsError && !isMissingTable(sessionsError)) throw sessionsError;
    const exoSessions = (sessions || []).filter((s) => String(s.vast_tag_url || '').includes('magsrv'));
    vastByProvider.exoclick = exoSessions.length;
  }

  return (providers || []).map((p) => {
    const pe = (events || []).filter((e) => e.provider_id === p.id);
    const impressions = pe.filter((e) => ['impression', 'started', 'request'].includes(e.event_type)).length;
    const clicks = pe.filter((e) => e.event_type === 'click').length;
    const errors = pe.filter((e) => ['error', 'timeout', 'empty_vast', 'no_fill', 'blocked'].includes(e.event_type)).length;
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
  const { data, error } = await supabase
    .from('ad_monitoring_events')
    .select('created_at,event_type,revenue_usd')
    .gte('created_at', since)
    .order('created_at');
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
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
