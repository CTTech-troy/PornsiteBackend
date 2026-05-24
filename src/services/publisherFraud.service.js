import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';

const recentClicks = new Map();

export async function scoreEventFraud({ partnerId, ipHash, eventType, publicToken }) {
  const flags = {};
  let isValid = true;

  if (!ipHash) {
    flags.missing_ip = true;
    isValid = false;
  }

  const key = `${publicToken}:${ipHash}:${eventType}`;
  const now = Date.now();
  const last = recentClicks.get(key) || 0;
  if (now - last < 500) {
    flags.rate_limit = true;
    isValid = false;
  }
  recentClicks.set(key, now);

  if (partnerId && ipHash) {
    const since = new Date(Date.now() - 3600000).toISOString();
    const { count } = await supabase
      .from('publisher_ad_events')
      .select('id', { count: 'exact', head: true })
      .eq('partner_id', partnerId)
      .eq('ip_hash', ipHash)
      .eq('event_type', 'click')
      .gte('created_at', since);
    if ((count || 0) > 50) {
      flags.click_burst = true;
      isValid = false;
    }
  }

  const settings = await getPlatformSettingsMap();
  const threshold = Number(settings.publisher_fraud_threshold || 75);

  return { isValid, flags, threshold };
}

export async function updatePartnerFraudScore(partnerId) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: events } = await supabase
    .from('publisher_ad_events')
    .select('is_valid')
    .eq('partner_id', partnerId)
    .gte('created_at', since);
  const total = events?.length || 0;
  const invalid = (events || []).filter((e) => !e.is_valid).length;
  const score = total ? Math.round((invalid / total) * 100) : 0;
  await supabase.from('publisher_partners').update({ fraud_score: score, updated_at: new Date().toISOString() }).eq('id', partnerId);
  return score;
}
