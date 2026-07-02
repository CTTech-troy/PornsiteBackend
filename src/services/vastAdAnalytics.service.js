import { supabase } from '../config/supabase.js';
import { isMissingDbFeature } from './revenueCalculation.service.js';

function emptyMetrics() {
  return {
    impressions: 0,
    completions: 0,
    skips: 0,
    errors: 0,
    clicks: 0,
    completionRate: 0,
    skipRate: 0,
    ctr: 0,
    estimatedRevenueUsd: 0,
    creatorEarningsUsd: 0,
    platformEarningsUsd: 0,
    watchTimeSeconds: 0,
  };
}

function aggregateEvents(sessions, events, earningsRows) {
  const metrics = emptyMetrics();
  const sessionIds = new Set((sessions || []).map((s) => s.id));

  for (const ev of events || []) {
    if (!sessionIds.has(ev.session_id)) continue;
    if (ev.event_type === 'impression') metrics.impressions += 1;
    if (ev.event_type === 'complete') metrics.completions += 1;
    if (ev.event_type === 'skip') metrics.skips += 1;
    if (ev.event_type === 'error' || ev.event_type === 'unsupported' || ev.event_type === 'no_fill') metrics.errors += 1;
    if (ev.event_type === 'click') metrics.clicks += 1;
    if (ev.event_type === 'watch_progress') {
      metrics.watchTimeSeconds += Number(ev.metadata?.watchedSeconds || 0);
    }
  }

  for (const row of earningsRows || []) {
    metrics.creatorEarningsUsd += Number(row.amount_usd || 0);
    metrics.platformEarningsUsd += Number(row.platform_fee_usd || 0);
    metrics.estimatedRevenueUsd += Number(row.gross_usd || row.amount_usd || 0);
  }

  const denom = metrics.impressions || 1;
  metrics.completionRate = Math.round((metrics.completions / denom) * 1000) / 10;
  metrics.skipRate = Math.round((metrics.skips / denom) * 1000) / 10;
  metrics.ctr = Math.round((metrics.clicks / denom) * 1000) / 10;

  return metrics;
}

export async function getVastAdMetrics({ creatorId = null, from, to } = {}) {
  if (!supabase) return { ...emptyMetrics(), daily: [] };

  let sessionsQuery = supabase
    .from('vast_ad_sessions')
    .select('id, video_id, creator_id, status, started_at, completed_at')
    .gte('started_at', from.toISOString())
    .lte('started_at', to.toISOString());
  if (creatorId) sessionsQuery = sessionsQuery.eq('creator_id', creatorId);

  const { data: sessions, error: sessErr } = await sessionsQuery;
  if (sessErr && isMissingDbFeature(sessErr)) return { ...emptyMetrics(), daily: [] };
  if (sessErr) throw sessErr;

  const sessionIds = (sessions || []).map((s) => s.id);
  if (!sessionIds.length) return { ...emptyMetrics(), daily: [] };

  const { data: events, error: evErr } = await supabase
    .from('vast_ad_events')
    .select('session_id, event_type, metadata, created_at')
    .in('session_id', sessionIds);
  if (evErr && !isMissingDbFeature(evErr)) throw evErr;

  let earningsQuery = supabase
    .from('creator_earnings')
    .select('amount_usd, gross_usd, platform_fee_usd, reference_id, created_at')
    .in('source', ['ad', 'ad_reward'])
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString());
  if (creatorId) earningsQuery = earningsQuery.eq('creator_id', creatorId);
  const { data: earnings } = await earningsQuery;

  const metrics = aggregateEvents(sessions, events || [], earnings || []);

  const dailyMap = new Map();
  for (const s of sessions || []) {
    const day = String(s.started_at).slice(0, 10);
    if (!dailyMap.has(day)) dailyMap.set(day, { date: day, impressions: 0, completions: 0, skips: 0 });
    const row = dailyMap.get(day);
    const sessionEvents = (events || []).filter((e) => e.session_id === s.id);
    if (sessionEvents.some((e) => e.event_type === 'impression')) row.impressions += 1;
    if (sessionEvents.some((e) => e.event_type === 'complete')) row.completions += 1;
    if (sessionEvents.some((e) => e.event_type === 'skip')) row.skips += 1;
  }

  return {
    ...metrics,
    sessions: sessions.length,
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
