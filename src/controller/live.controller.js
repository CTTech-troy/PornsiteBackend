import { supabase, isConfigured } from '../config/supabase.js';

// Simple helpers that use Supabase Postgres. If Supabase is not configured,
// these functions will throw — calling code should handle gracefully.

async function createLive(hostId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').insert([{ host_id: hostId, status: 'live', viewers_count: 1 }]).select().single();
  if (error) throw error;
  return data;
}

async function getLive(liveId) {
  if (!isConfigured()) return null;
  const { data, error } = await supabase.from('lives').select('*').eq('id', liveId).maybeSingle();
  if (error) throw error;
  return data;
}

async function endLive(liveId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  // compute payout before ending
  const { data: live, error: liveErr } = await supabase.from('lives').select('*').eq('id', liveId).maybeSingle();
  if (liveErr) throw liveErr;
  if (!live) throw new Error('Live not found');

  const total = Number(live.total_gifts_amount || 0);
  const companyShare = +(total * 0.3).toFixed(2);
  const hostShare = +(total * 0.7).toFixed(2);

  // credit host wallet
  const hostId = live.host_id;
  // upsert wallet
  const { data: wallet, error: walletErr } = await supabase.from('wallets').upsert({ owner_id: hostId }, { onConflict: 'owner_id' }).select().maybeSingle();
  if (walletErr) throw walletErr;
  // increase balance
  const { data: updatedWallet, error: updateErr } = await supabase.rpc('increment_wallet_balance', { p_owner_id: hostId, p_amount: hostShare }).rpcResult || {};
  // If rpc not available, fallback to simple update
  if (updateErr) {
    const { data: w2, error: w2err } = await supabase.from('wallets').select('*').eq('owner_id', hostId).maybeSingle();
    if (w2err) throw w2err;
    if (w2) {
      const newBal = Number(w2.balance || 0) + hostShare;
      const { error: up } = await supabase.from('wallets').update({ balance: newBal, updated_at: new Date().toISOString() }).eq('owner_id', hostId);
      if (up) throw up;
    } else {
      const { error: ins } = await supabase.from('wallets').insert([{ owner_id: hostId, balance: hostShare }]);
      if (ins) throw ins;
    }
  }

  // update live status and ended_at
  const { data: ended, error: endErr } = await supabase.from('lives').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', liveId).select().maybeSingle();
  if (endErr) throw endErr;

  // return payout summary
  return { total, companyShare, hostShare };
}

async function pauseLive(liveId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').update({ status: 'paused' }).eq('id', liveId).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function joinLive(liveId, userId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  // check if active viewer exists
  const { data: existing } = await supabase.from('live_viewers').select('*').eq('live_id', liveId).eq('user_id', userId).maybeSingle();
  if (existing && existing.is_active) return existing;
  if (existing && !existing.is_active) {
    const { data, error } = await supabase.from('live_viewers').update({ is_active: true, joined_at: new Date().toISOString(), left_at: null }).eq('id', existing.id).select().maybeSingle();
    if (error) throw error;
    await supabase.from('lives').update({ viewers_count: supabase.raw('viewers_count + 1') }).eq('id', liveId);
    return data;
  }
  const { data, error } = await supabase.from('live_viewers').insert([{ live_id: liveId, user_id: userId }]).select().maybeSingle();
  if (error) throw error;
  await supabase.from('lives').update({ viewers_count: supabase.raw('viewers_count + 1') }).eq('id', liveId);
  return data;
}

async function leaveLive(liveId, userId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data: existing } = await supabase.from('live_viewers').select('*').eq('live_id', liveId).eq('user_id', userId).maybeSingle();
  if (!existing || !existing.is_active) return null;
  const { data, error } = await supabase.from('live_viewers').update({ is_active: false, left_at: new Date().toISOString() }).eq('id', existing.id).select().maybeSingle();
  if (error) throw error;
  await supabase.from('lives').update({ viewers_count: supabase.raw('GREATEST(viewers_count - 1, 0)') }).eq('id', liveId);
  return data;
}

async function likeLive(liveId) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').update({ total_likes: supabase.raw('total_likes + 1') }).eq('id', liveId).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function commentLive(liveId, userId, message) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('live_comments').insert([{ live_id: liveId, user_id: userId, message }]).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function sendGift(liveId, senderId, giftType, amount) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('live_gifts').insert([{ live_id: liveId, sender_id: senderId, gift_type: giftType, amount }]).select().maybeSingle();
  if (error) throw error;
  // update total on lives
  await supabase.from('lives').update({ total_gifts_amount: supabase.raw('total_gifts_amount + ' + Number(amount)) }).eq('id', liveId);
  return data;
}

export {
  createLive,
  getLive,
  endLive,
  pauseLive,
  joinLive,
  leaveLive,
  likeLive,
  commentLive,
  sendGift
};
