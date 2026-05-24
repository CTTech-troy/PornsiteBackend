import { supabase } from '../config/supabase.js';

export async function getPartnerOverview(partnerId) {
  const { data: partner } = await supabase.from('publisher_partners').select('*').eq('id', partnerId).maybeSingle();

  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: events } = await supabase
    .from('publisher_ad_events')
    .select('event_type, revenue_usd, is_valid, created_at')
    .eq('partner_id', partnerId)
    .gte('created_at', since30);

  const valid = (events || []).filter((e) => e.is_valid);
  const impressions = valid.filter((e) => e.event_type === 'impression').length;
  const clicks = valid.filter((e) => e.event_type === 'click').length;
  const revenue = valid.reduce((s, e) => s + Number(e.revenue_usd || 0), 0);
  const ctr = impressions ? (clicks / impressions) * 100 : 0;
  const rpm = impressions ? (revenue / impressions) * 1000 : 0;

  const { data: referrals } = await supabase
    .from('publisher_referrals')
    .select('id, converted_at')
    .eq('partner_id', partnerId);

  return {
    partner,
    impressions,
    clicks,
    ctr: Math.round(ctr * 100) / 100,
    rpm: Math.round(rpm * 100) / 100,
    revenueUsd: Math.round(revenue * 100) / 100,
    pendingUsd: Number(partner?.pending_usd || 0),
    balanceUsd: Number(partner?.balance_usd || 0),
    referralClicks: referrals?.length || 0,
    referralConversions: (referrals || []).filter((r) => r.converted_at).length,
  };
}

export async function getPartnerEventSeries(partnerId, days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: events } = await supabase
    .from('publisher_ad_events')
    .select('event_type, created_at, revenue_usd')
    .eq('partner_id', partnerId)
    .eq('is_valid', true)
    .gte('created_at', since);

  const buckets = {};
  for (const e of events || []) {
    const day = e.created_at.slice(0, 10);
    if (!buckets[day]) buckets[day] = { date: day, impressions: 0, clicks: 0, revenue: 0 };
    if (e.event_type === 'impression') buckets[day].impressions += 1;
    if (e.event_type === 'click') buckets[day].clicks += 1;
    buckets[day].revenue += Number(e.revenue_usd || 0);
  }
  return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
}
