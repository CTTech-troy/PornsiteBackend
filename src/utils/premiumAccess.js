import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';

export function getVideoAccessType(row = {}) {
  const raw = String(row.access_type || row.accessType || '').trim().toLowerCase().replace(/-/g, '_');
  if (['free', 'premium', 'members_only', 'coin_unlock'].includes(raw)) return raw;
  const tokenPrice = Number(row.token_price ?? row.tokenPrice ?? row.coin_price ?? row.coinPrice ?? 0) || 0;
  if (row.requires_membership === true || row.requiresMembership === true) return 'members_only';
  if (tokenPrice > 0) return 'coin_unlock';
  if (row.is_premium_content === true || row.isPremiumContent === true || row.isPremium === true || row.premium === true) return 'premium';
  return 'free';
}

export function isPremiumVideoRow(row) {
  const accessType = getVideoAccessType(row);
  return !!(
    row &&
    (accessType !== 'free' ||
      row.is_premium_content === true ||
      row.isPremiumContent === true ||
      Number(row.token_price || row.tokenPrice || 0) > 0 ||
      Number(row.coin_price || row.coinPrice || 0) > 0 ||
      row.requires_membership === true ||
      row.requiresMembership === true ||
      row.subscription_access === true ||
      row.subscriptionAccess === true)
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
  if (!uid || !videoId) return false;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('video_purchases')
        .select('id')
        .eq('user_id', uid)
        .eq('video_id', videoId)
        .maybeSingle();
      if (data) return true;
    } catch {
      /* fall through to generic purchase checks */
    }
    try {
      const { data } = await supabase
        .from('public_video_purchases')
        .select('id')
        .eq('user_id', uid)
        .eq('public_video_id', videoId)
        .maybeSingle();
      if (data) return true;
    } catch {
      /* fall through to Firebase fallback */
    }
  }
  try {
    const rtdb = getFirebaseRtdb();
    if (!rtdb) return false;
    const snap = await rtdb.ref(`videoPurchases/${uid}/${videoId}`).once('value');
    return snap.exists();
  } catch {
    return false;
  }
}

export async function canAccessPremiumVideo(uid, row) {
  if (!isPremiumVideoRow(row)) return true;
  if (!uid) return false;
  if (row?.user_id && String(row.user_id) === String(uid)) return true;
  if (row?.userId && String(row.userId) === String(uid)) return true;

  const accessType = getVideoAccessType(row);
  const videoId = row?.video_id || row?.videoId || row?.id;
  const activePremium = await hasActivePremiumAccess(uid);

  if (accessType === 'members_only') return activePremium;
  if (accessType === 'coin_unlock') {
    if (videoId && (await hasPurchasedVideo(uid, videoId))) return true;
    if ((row.subscription_access === true || row.subscriptionAccess === true) && activePremium) return true;
    return false;
  }
  if (activePremium) return true;
  if (videoId && (await hasPurchasedVideo(uid, videoId))) return true;
  return false;
}
