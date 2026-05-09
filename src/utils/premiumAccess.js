import { supabase } from '../config/supabase.js';

export function isPremiumVideoRow(row) {
  return !!(
    row &&
    (row.is_premium_content === true ||
      Number(row.token_price || 0) > 0 ||
      Number(row.coin_price || 0) > 0)
  );
}

export async function hasActivePremiumAccess(uid) {
  if (!uid || !supabase) return false;
  try {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    if (!data) return false;
    const activeMembership =
      data.membership === 'active' ||
      data.membership_status === 'active' ||
      data.membershipStatus === 'active';
    return data.is_premium === true || data.isPremium === true || activeMembership;
  } catch {
    return false;
  }
}

export async function hasPurchasedVideo(uid, videoId) {
  if (!uid || !videoId || !supabase) return false;
  try {
    const { data } = await supabase
      .from('video_purchases')
      .select('id')
      .eq('user_id', uid)
      .eq('video_id', videoId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

export async function canAccessPremiumVideo(uid, row) {
  if (!isPremiumVideoRow(row)) return true;
  if (!uid) return false;
  if (row?.user_id && String(row.user_id) === String(uid)) return true;
  if (await hasActivePremiumAccess(uid)) return true;
  if (row?.video_id && (await hasPurchasedVideo(uid, row.video_id))) return true;
  return false;
}
