import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';
import { isMissingDbFeature, money, recordCreatorEarning } from './revenueCalculation.service.js';

export async function getAdRewardSettings() {
  const map = await getPlatformSettingsMap();
  const per1k = Math.max(0, Number(map.ad_creator_reward_per_1k_views) || 0.6);
  return {
    enabled: map.ad_revenue_enabled !== 'false',
    rewardPer1kViews: per1k,
    rewardPerView: money(per1k / 1000),
    minWatchSec: Math.max(0, Number(map.ad_valid_view_min_watch_sec) || 5),
    requireImpression: map.ad_reward_require_impression !== 'false',
    fraudProtection: map.ad_reward_fraud_protection !== 'false',
    maxDailyPerViewer: Math.max(1, Number(map.ad_reward_max_daily_per_viewer) || 100),
    minCompleteMs: Math.max(500, Number(map.ad_reward_min_complete_ms) || 1000),
    estimatedCpmUsd: Math.max(0, Number(map.vast_estimated_cpm_usd) || 2),
    platformGrossPerView: money((Math.max(0, Number(map.vast_estimated_cpm_usd) || 2)) / 1000),
    skipAfterSeconds: Math.max(0, Number(map.vast_skip_after_seconds_default) || 5),
  };
}

async function loadSessionEvents(sessionId) {
  if (!supabase || !sessionId) return [];
  const { data, error } = await supabase
    .from('vast_ad_events')
    .select('event_type, metadata, created_at')
    .eq('session_id', sessionId);
  if (error && isMissingDbFeature(error)) return [];
  if (error) throw error;
  return data || [];
}

function maxWatchedMs(events, metadata = {}) {
  let max = Number(metadata.watchedMs || 0);
  for (const ev of events) {
    if (ev.event_type === 'watch_progress' || ev.event_type === 'skip' || ev.event_type === 'complete') {
      max = Math.max(max, Number(ev.metadata?.watchedMs || 0));
    }
  }
  return max;
}

async function countViewerRewardsToday(viewerKey) {
  if (!supabase || !viewerKey) return 0;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('creator_ad_valid_views')
    .select('id', { count: 'exact', head: true })
    .eq('viewer_key', viewerKey)
    .gte('created_at', start.toISOString());
  if (error && isMissingDbFeature(error)) return 0;
  if (error) throw error;
  return count || 0;
}

async function sessionAlreadyCredited(sessionId) {
  if (!supabase) return false;
  const { data } = await supabase
    .from('creator_ad_valid_views')
    .select('id')
    .eq('session_id', sessionId)
    .maybeSingle();
  return Boolean(data?.id);
}

export async function validateAdViewQualification({ session, eventType, metadata = {}, events = null }) {
  const settings = await getAdRewardSettings();
  const flags = { qualified: false, reasons: [] };

  if (!settings.enabled) {
    flags.reasons.push('ad_revenue_disabled');
    return { ...flags, settings };
  }
  if (!session?.creator_id) {
    flags.reasons.push('no_creator');
    return { ...flags, settings };
  }

  const viewerKey = session.user_id || session.fingerprint;
  if (!viewerKey) {
    flags.reasons.push('missing_viewer_identity');
    return { ...flags, settings };
  }

  const normalized = String(eventType || '').toLowerCase();
  if (!['complete', 'skip'].includes(normalized)) {
    flags.reasons.push('not_terminal_event');
    return { ...flags, settings };
  }

  const sessionEvents = events || await loadSessionEvents(session.id);
  const hasImpression = sessionEvents.some((e) => e.event_type === 'impression')
    || sessionEvents.some((e) => e.event_type === 'started');
  if (settings.requireImpression && !hasImpression) {
    flags.reasons.push('no_impression');
    return { ...flags, settings };
  }

  const watchedMs = maxWatchedMs(sessionEvents, metadata);
  const minWatchMs = settings.minWatchSec * 1000;
  const skipAfterMs = (session.skip_after_seconds || settings.skipAfterSeconds) * 1000;

  const meetsWatch =
    normalized === 'complete'
    || (normalized === 'skip' && watchedMs >= Math.min(minWatchMs, skipAfterMs));

  if (!meetsWatch) {
    flags.reasons.push('insufficient_watch_time');
    flags.watchedMs = watchedMs;
    flags.requiredMs = Math.min(minWatchMs, skipAfterMs);
    return { ...flags, settings };
  }

  if (settings.fraudProtection) {
    if (normalized === 'complete' && watchedMs > 0 && watchedMs < settings.minCompleteMs) {
      flags.reasons.push('complete_too_fast');
      return { ...flags, settings };
    }
    const daily = await countViewerRewardsToday(viewerKey);
    if (daily >= settings.maxDailyPerViewer) {
      flags.reasons.push('daily_viewer_cap');
      return { ...flags, settings };
    }
  }

  if (session.reward_credited || await sessionAlreadyCredited(session.id)) {
    flags.reasons.push('already_credited');
    return { ...flags, settings };
  }

  flags.qualified = true;
  flags.watchedMs = watchedMs;
  return { ...flags, settings };
}

export async function creditValidAdView({ session, eventType, metadata = {} }) {
  const validation = await validateAdViewQualification({ session, eventType, metadata });
  if (!validation.qualified) {
    return { credited: false, validation };
  }

  const settings = validation.settings;
  const rewardUsd = settings.rewardPerView;
  const platformGrossUsd = settings.platformGrossPerView;
  const viewerKey = session.user_id || session.fingerprint;
  const referenceId = `ad_reward:vast:${session.id}`;

  if (supabase) {
    const { error: viewErr } = await supabase.from('creator_ad_valid_views').insert({
      session_id: session.id,
      video_id: session.video_id,
      creator_id: session.creator_id,
      user_id: session.user_id || null,
      fingerprint: session.fingerprint || null,
      viewer_key: viewerKey,
      reward_usd: rewardUsd,
      platform_gross_usd: platformGrossUsd,
      validation_flags: { eventType, watchedMs: validation.watchedMs },
    });
    if (viewErr && !isMissingDbFeature(viewErr) && viewErr.code !== '23505') throw viewErr;

    const { error: ledgerErr } = await supabase.from('platform_ad_revenue_ledger').insert({
      source: 'vast_preroll',
      provider_slug: metadata.provider || 'exoclick',
      gross_usd: platformGrossUsd,
      session_id: session.id,
      reference_id: `platform_ad:vast:${session.id}`,
      metadata: { videoId: session.video_id, creatorId: session.creator_id },
    });
    if (ledgerErr && !isMissingDbFeature(ledgerErr) && ledgerErr.code !== '23505') throw ledgerErr;

    await supabase.from('vast_ad_sessions').update({
      reward_credited: true,
      creator_reward_usd: rewardUsd,
      platform_gross_usd: platformGrossUsd,
    }).eq('id', session.id);
  }

  await recordCreatorEarning({
    creatorId: session.creator_id,
    grossUsd: rewardUsd,
    source: 'ad_reward',
    referenceId,
    metadata: {
      videoId: session.video_id,
      sessionId: session.id,
      eventType,
      watchedMs: validation.watchedMs,
      model: 'flat_per_valid_view',
    },
  });

  return {
    credited: true,
    rewardUsd,
    platformGrossUsd,
    validation,
  };
}

export async function getAdRewardAnalytics({ from, to } = {}) {
  if (!supabase) {
    return {
      validViews: 0,
      creatorRewardsUsd: 0,
      platformGrossUsd: 0,
      netProfitUsd: 0,
      impressions: 0,
    };
  }

  const fromIso = from?.toISOString?.() || new Date(Date.now() - 30 * 864e5).toISOString();
  const toIso = to?.toISOString?.() || new Date().toISOString();

  const [viewsRes, ledgerRes, eventsRes] = await Promise.all([
    supabase
      .from('creator_ad_valid_views')
      .select('reward_usd, platform_gross_usd')
      .gte('created_at', fromIso)
      .lte('created_at', toIso),
    supabase
      .from('platform_ad_revenue_ledger')
      .select('gross_usd')
      .gte('created_at', fromIso)
      .lte('created_at', toIso),
    supabase
      .from('vast_ad_events')
      .select('session_id')
      .eq('event_type', 'impression')
      .gte('created_at', fromIso)
      .lte('created_at', toIso),
  ]);

  const views = viewsRes.data || [];
  const ledger = ledgerRes.data || [];
  const creatorRewardsUsd = money(views.reduce((s, r) => s + Number(r.reward_usd || 0), 0));
  const platformGrossUsd = money(
    ledger.reduce((s, r) => s + Number(r.gross_usd || 0), 0)
      || views.reduce((s, r) => s + Number(r.platform_gross_usd || 0), 0),
  );
  const validViews = views.length;
  const impressions = (eventsRes.data || []).length;

  return {
    validViews,
    impressions,
    creatorRewardsUsd,
    platformGrossUsd,
    netProfitUsd: money(Math.max(0, platformGrossUsd - creatorRewardsUsd)),
  };
}
