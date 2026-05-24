import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';

export async function creditPublisherEvent({ partner, unit, eventType }) {
  if (!partner?.id) return 0;
  const settings = await getPlatformSettingsMap();
  const cpm = Number(settings.publisher_cpm_usd || 1.5);
  const cpc = Number(settings.publisher_cpc_usd || 0.05);
  const sharePct = Number(settings.publisher_revenue_share_percent || 70) / 100;

  let gross = 0;
  if (eventType === 'impression') gross = cpm / 1000;
  if (eventType === 'click') gross = cpc;

  const amount = Math.round(gross * sharePct * 10000) / 10000;
  if (amount <= 0) return 0;

  await supabase.from('publisher_earnings').insert([{
    partner_id: partner.id,
    source: eventType === 'click' ? 'cpc' : 'cpm',
    amount_usd: amount,
    status: 'pending',
    reference_id: unit?.id || null,
    description: `${eventType} on ${unit?.name || 'ad unit'}`,
  }]);

  const { data: p } = await supabase.from('publisher_partners').select('pending_usd, total_earned_usd').eq('id', partner.id).maybeSingle();
  await supabase.from('publisher_partners').update({
    pending_usd: Number(p?.pending_usd || 0) + amount,
    total_earned_usd: Number(p?.total_earned_usd || 0) + amount,
    updated_at: new Date().toISOString(),
  }).eq('id', partner.id);

  return amount;
}

export async function attributeReferral({ partnerCode, referralType, targetUserId, landingPath }) {
  const { data: partner } = await supabase.from('publisher_partners').select('id').eq('partner_code', partnerCode).maybeSingle();
  if (!partner) return null;

  const settings = await getPlatformSettingsMap();
  const commissionPct = Number(settings.publisher_referral_commission_percent || 10) / 100;

  const { data, error } = await supabase.from('publisher_referrals').insert([{
    partner_id: partner.id,
    referral_type: referralType,
    target_user_id: targetUserId || null,
    landing_path: landingPath || null,
    status: targetUserId ? 'approved' : 'pending',
    converted_at: targetUserId ? new Date().toISOString() : null,
  }]).select('*').single();
  if (error) throw error;
  return { referral: data, commissionPct };
}
