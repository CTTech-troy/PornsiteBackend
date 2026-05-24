import { supabase } from '../config/supabase.js';
import { hashIp } from '../utils/publisherUtils.js';
import { scoreEventFraud } from './publisherFraud.service.js';
import { creditPublisherEvent } from './publisherRevenue.service.js';

export async function trackPublisherEvent({
  eventType,
  publicToken,
  ip,
  userAgent,
  referrer,
  geo,
  deviceFingerprint,
}) {
  const { data: embed, error } = await supabase
    .from('publisher_embed_tokens')
    .select('*, publisher_ad_units(*, publisher_partners(*))')
    .eq('public_token', publicToken)
    .maybeSingle();
  if (error) throw error;
  if (!embed || embed.revoked_at) return { ok: false, reason: 'invalid_token' };

  const unit = embed.publisher_ad_units;
  const partner = unit?.publisher_partners;
  if (!unit || unit.status !== 'active') return { ok: false, reason: 'inactive_unit' };

  const ipHash = hashIp(ip);
  const fraud = await scoreEventFraud({ partnerId: partner?.id, ipHash, eventType, publicToken, geo });
  if (geo?.country) {
    const { getPlatformSettingsMap } = await import('./platformSettings.service.js');
    const settings = await getPlatformSettingsMap();
    const blocked = String(settings.publisher_blocked_countries || '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (blocked.includes(String(geo.country).toUpperCase())) {
      fraud.isValid = false;
      fraud.flags = { ...fraud.flags, geo_blocked: true };
    }
  }

  const row = {
    event_type: eventType,
    ad_unit_id: unit.id,
    partner_id: partner?.id || null,
    token: publicToken,
    ip_hash: ipHash,
    device_fingerprint: deviceFingerprint || null,
    geo: geo || null,
    referrer: referrer ? String(referrer).slice(0, 512) : null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    is_valid: fraud.isValid,
    fraud_flags: fraud.flags,
    revenue_usd: 0,
  };

  if (fraud.isValid) {
    row.revenue_usd = await creditPublisherEvent({ partner, unit, eventType });
  }

  await supabase.from('publisher_ad_events').insert([row]);

  const inc = eventType === 'impression'
    ? { impressions: 1, revenue_usd: row.revenue_usd }
    : { clicks: 1, revenue_usd: row.revenue_usd };

  await supabase.from('publisher_ad_units').update({
    impressions: Number(unit.impressions || 0) + (inc.impressions || 0),
    clicks: Number(unit.clicks || 0) + (inc.clicks || 0),
    revenue_usd: Number(unit.revenue_usd || 0) + Number(inc.revenue_usd || 0),
    updated_at: new Date().toISOString(),
  }).eq('id', unit.id);

  return { ok: true, eventType, revenueUsd: row.revenue_usd, isValid: fraud.isValid };
}
