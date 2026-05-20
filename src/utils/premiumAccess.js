import { supabase } from '../config/supabase.js';
import { getFirebaseRtdb } from '../config/firebase.js';

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
  if (await hasActivePremiumAccess(uid)) return true;
  if (row?.video_id && (await hasPurchasedVideo(uid, row.video_id))) return true;
  return false;
}
