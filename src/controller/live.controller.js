import { supabase, isConfigured } from '../config/supabase.js';
import * as liveCache from '../config/live-cache.js';
import { getPublicProfile } from '../config/dbFallback.js';

function isSupabaseUnreachable(err) {
  const msg = err?.message || err?.cause?.message || err?.error_description || String(err);
  return /fetch failed|ECONNREFUSED|timeout|Database unreachable/i.test(msg);
}

async function createLive(hostId, hostDisplayName = null) {
  const existing = await getMyActiveLive(hostId);
  if (existing) throw new Error('You must end your current live stream before starting another.');
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('lives').insert([{
        host_id: hostId,
        status: 'live',
        viewers_count: 1
      }]).select().single();
      if (error) throw error;
      return data;
    } catch (err) {
      if (err?.message?.includes('must end your current live')) throw err;
      if (isSupabaseUnreachable(err)) {
        await liveCache.syncCacheToSupabase();
        const cached = await liveCache.createInCache(hostId, hostDisplayName);
        if (cached) return cached;
        throw new Error('Database unreachable');
      }
      throw err;
    }
  }
  await liveCache.syncCacheToSupabase();
  const cached = await liveCache.createInCache(hostId, hostDisplayName);
  if (cached) return cached;
  throw new Error('Supabase not configured');
}

async function getMyActiveLive(hostId) {
  if (!hostId) return null;
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('lives').select('id, host_id, status, viewers_count, total_likes, total_gifts_amount, created_at').eq('host_id', hostId).in('status', ['live', 'paused']).order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      const row = Array.isArray(data) && data.length ? data[0] : null;
      if (row?.host_id) {
        const profile = await getPublicProfile(row.host_id).catch(() => null);
        if (profile) row.host_display_name = profile.displayName;
      }
      return row;
    } catch (err) {
      if (isSupabaseUnreachable(err)) {
        const list = await liveCache.listFromCache('live');
        const paused = await liveCache.listFromCache('paused');
        const combined = [...list, ...paused].filter((row) => row.host_id === hostId).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const row = combined[0] || null;
        if (row?.host_id) {
          const profile = await getPublicProfile(row.host_id).catch(() => null);
          if (profile) row.host_display_name = profile.displayName;
        }
        return row;
      }
      return null;
    }
  }
  const list = await liveCache.listFromCache('live');
  const paused = await liveCache.listFromCache('paused');
  const combined = [...list, ...paused].filter((row) => row.host_id === hostId).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const row = combined[0] || null;
  if (row?.host_id) {
    const profile = await getPublicProfile(row.host_id).catch(() => null);
    if (profile) row.host_display_name = profile.displayName;
  }
  return row;
}

async function getLive(liveId, opts = {}) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('lives').select('*').eq('id', liveId).maybeSingle();
      if (error) throw error;
      if (data) {
        if (data.host_id) {
          const profile = await getPublicProfile(data.host_id).catch(() => null);
          if (profile) data.host_display_name = profile.displayName;
        }
        return opts.includeSource ? { ...data, _fromCache: false } : data;
      }
    } catch (err) {
      if (!isSupabaseUnreachable(err)) {
        console.warn('live.getLive:', err?.message || err?.cause?.message || err);
        return null;
      }
    }
  }
  const cached = await liveCache.getFromCache(liveId);
  if (cached) {
    if (cached.host_id) {
      const profile = await getPublicProfile(cached.host_id).catch(() => null);
      if (profile) cached.host_display_name = profile.displayName;
    }
    return opts.includeSource ? { ...cached, _fromCache: true } : cached;
  }
  return null;
}

async function listLives(status = 'live') {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('lives').select('id, host_id, status, viewers_count, total_likes, total_gifts_amount, created_at').eq('status', status).order('created_at', { ascending: false });
      if (error) throw error;
      const list = data || [];
      const hostIds = [...new Set(list.map((r) => r.host_id).filter(Boolean))];
      const profiles = await Promise.all(hostIds.map((id) => getPublicProfile(id).then((p) => ({ id, displayName: p?.displayName })).catch(() => ({ id, displayName: null }))));
      const nameByHost = Object.fromEntries(profiles.map((p) => [p.id, p.displayName]));
      list.forEach((r) => { if (r.host_id && nameByHost[r.host_id]) r.host_display_name = nameByHost[r.host_id]; });
      return list;
    } catch (err) {
      if (isSupabaseUnreachable(err)) {
        liveCache.syncCacheToSupabase().catch(() => {});
        const list = await liveCache.listFromCache(status);
        const rows = list.map((row) => {
          const { _fromCache, ...rest } = row;
          return rest;
        });
        const hostIds = [...new Set(rows.map((r) => r.host_id).filter(Boolean))];
        const profiles = await Promise.all(hostIds.map((id) => getPublicProfile(id).then((p) => ({ id, displayName: p?.displayName })).catch(() => ({ id, displayName: null }))));
        const nameByHost = Object.fromEntries(profiles.map((p) => [p.id, p.displayName]));
        rows.forEach((r) => { if (r.host_id && nameByHost[r.host_id]) r.host_display_name = nameByHost[r.host_id]; });
        return rows;
      }
      console.warn('live.listLives:', err?.message || err?.cause?.message || err);
      return [];
    }
  }
  const list = await liveCache.listFromCache(status);
  const rows = list.map((row) => {
    const { _fromCache, ...rest } = row;
    return rest;
  });
  const hostIds = [...new Set(rows.map((r) => r.host_id).filter(Boolean))];
  const profiles = await Promise.all(hostIds.map((id) => getPublicProfile(id).then((p) => ({ id, displayName: p?.displayName })).catch(() => ({ id, displayName: null }))));
  const nameByHost = Object.fromEntries(profiles.map((p) => [p.id, p.displayName]));
  rows.forEach((r) => { if (r.host_id && nameByHost[r.host_id]) r.host_display_name = nameByHost[r.host_id]; });
  return rows;
}

async function endLive(liveId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  const total = Number(live.total_gifts_amount || 0);
  const companyShare = +(total * 0.3).toFixed(2);
  const hostShare = +(total * 0.7).toFixed(2);
  const now = new Date().toISOString();

  if (live._fromCache) {
    await liveCache.updateInCache(liveId, { status: 'ended', ended_at: now });
    return { total, companyShare, hostShare };
  }

  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const hostId = live.host_id;
  try {
    // Ensure wallet exists and credit host share (no upsert — wallets may not have UNIQUE on owner_id)
    const { data: w2, error: w2err } = await supabase.from('wallets').select('*').eq('owner_id', hostId).maybeSingle();
    if (w2err) throw w2err;
    if (w2) {
      const newBal = Number(w2.balance || 0) + hostShare;
      const { error: up } = await supabase.from('wallets').update({ balance: newBal, updated_at: now }).eq('owner_id', hostId);
      if (up) throw up;
    } else {
      const { error: ins } = await supabase.from('wallets').insert([{ owner_id: hostId, balance: hostShare }]);
      if (ins) throw ins;
    }
    if (companyShare > 0) {
      await supabase.from('transactions').insert([{
        owner_id: 'company',
        type: 'company_commission',
        amount: companyShare,
        balance_after: companyShare,
        meta: { live_id: liveId, host_id: hostId }
      }]);
    }
    const { error: endErr } = await supabase.from('lives').update({ status: 'ended', ended_at: now }).eq('id', liveId);
    if (endErr) throw endErr;
    return { total, companyShare, hostShare };
  } catch (err) {
    // If Supabase is unreachable, fall back to RTDB cache so the live is marked ended.
    if (isSupabaseUnreachable(err)) {
      try {
        await liveCache.updateInCache(liveId, { status: 'ended', ended_at: now });
        return { total, companyShare, hostShare, _fallback: 'cache' };
      } catch (cacheErr) {
        // If cache update also fails, prefer returning the original error
        throw err;
      }
    }
    throw err;
  }
}

/**
 * End all active (live + paused) sessions from both Supabase and cache.
 * Returns array of { id, payout } or { id, error }.
 */
async function endAllActiveLives() {
  const seen = new Set();
  const ids = [];

  if (isConfigured()) {
    try {
      const liveList = await listLives('live');
      const pausedList = await listLives('paused');
      [...(Array.isArray(liveList) ? liveList : []), ...(Array.isArray(pausedList) ? pausedList : [])].forEach((item) => {
        const id = item?.id ?? item?.live_id;
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      });
    } catch (e) {
      console.warn('endAllActiveLives list from Supabase:', e?.message || e);
    }
  }

  if (liveCache.isRtdbAvailable && liveCache.isRtdbAvailable()) {
    try {
      const cacheLive = await liveCache.listFromCache('live');
      const cachePaused = await liveCache.listFromCache('paused');
      [...(Array.isArray(cacheLive) ? cacheLive : []), ...(Array.isArray(cachePaused) ? cachePaused : [])].forEach((row) => {
        const id = row?.id ?? row?.live_id;
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      });
    } catch (e) {
      console.warn('endAllActiveLives list from cache:', e?.message || e);
    }
  }

  const results = [];
  for (const id of ids) {
    try {
      const payout = await endLive(id);
      results.push({ id, payout });
    } catch (err) {
      results.push({ id, error: err?.message ?? String(err) });
    }
  }
  return results;
}

async function pauseLive(liveId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  if (live._fromCache) {
    await liveCache.updateInCache(liveId, { status: 'paused' });
    return { id: liveId, status: 'paused' };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').update({ status: 'paused' }).eq('id', liveId).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function resumeLive(liveId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  if (live._fromCache) {
    await liveCache.updateInCache(liveId, { status: 'live' });
    return { id: liveId, status: 'live' };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').update({ status: 'live' }).eq('id', liveId).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function joinLive(liveId, userId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  if (live._fromCache) {
    const next = (Number(live.viewers_count) || 0) + 1;
    await liveCache.updateInCache(liveId, { viewers_count: next });
    return { live_id: liveId, user_id: userId };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data: existing } = await supabase.from('live_viewers').select('*').eq('live_id', liveId).eq('user_id', userId).maybeSingle();
  if (existing && existing.is_active) return existing;
  if (existing && !existing.is_active) {
    const { data, error } = await supabase.from('live_viewers').update({ is_active: true, joined_at: new Date().toISOString(), left_at: null }).eq('id', existing.id).select().maybeSingle();
    if (error) throw error;
    const { data: liveRow } = await supabase.from('lives').select('viewers_count').eq('id', liveId).maybeSingle();
    const next = (Number(liveRow?.viewers_count) || 0) + 1;
    await supabase.from('lives').update({ viewers_count: next }).eq('id', liveId);
    return data;
  }
  const { data, error } = await supabase.from('live_viewers').insert([{ live_id: liveId, user_id: userId }]).select().maybeSingle();
  if (error) throw error;
  const { data: liveRow } = await supabase.from('lives').select('viewers_count').eq('id', liveId).maybeSingle();
  const next = (Number(liveRow?.viewers_count) || 0) + 1;
  await supabase.from('lives').update({ viewers_count: next }).eq('id', liveId);
  return data;
}

async function leaveLive(liveId, userId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) return null;
  if (live._fromCache) {
    const next = Math.max(0, (Number(live.viewers_count) || 0) - 1);
    await liveCache.updateInCache(liveId, { viewers_count: next });
    return { live_id: liveId, user_id: userId };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data: existing } = await supabase.from('live_viewers').select('*').eq('live_id', liveId).eq('user_id', userId).maybeSingle();
  if (!existing || !existing.is_active) return null;
  const { data, error } = await supabase.from('live_viewers').update({ is_active: false, left_at: new Date().toISOString() }).eq('id', existing.id).select().maybeSingle();
  if (error) throw error;
  const { data: liveRow } = await supabase.from('lives').select('viewers_count').eq('id', liveId).maybeSingle();
  const next = Math.max(0, (Number(liveRow?.viewers_count) || 0) - 1);
  await supabase.from('lives').update({ viewers_count: next }).eq('id', liveId);
  return data;
}

async function likeLive(liveId) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  const next = (Number(live.total_likes) || 0) + 1;
  if (live._fromCache) {
    await liveCache.updateInCache(liveId, { total_likes: next });
    return { id: liveId, total_likes: next };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('lives').update({ total_likes: next }).eq('id', liveId).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function commentLive(liveId, userId, message) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  if (live._fromCache) return { live_id: liveId, user_id: userId, message };
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('live_comments').insert([{ live_id: liveId, user_id: userId, message }]).select().maybeSingle();
  if (error) throw error;
  return data;
}

async function sendGift(liveId, senderId, giftType, amount) {
  const live = await getLive(liveId, { includeSource: true });
  if (!live) throw new Error('Live not found');
  const next = +(Number(live.total_gifts_amount) || 0) + Number(amount);
  if (live._fromCache) {
    await liveCache.updateInCache(liveId, { total_gifts_amount: next });
    return { live_id: liveId, sender_id: senderId, gift_type: giftType, amount };
  }
  if (!isConfigured() || !supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.from('live_gifts').insert([{ live_id: liveId, sender_id: senderId, gift_type: giftType, amount }]).select().maybeSingle();
  if (error) throw error;
  await supabase.from('lives').update({ total_gifts_amount: next }).eq('id', liveId);
  return data;
}

export {
  createLive,
  getLive,
  getMyActiveLive,
  listLives,
  endLive,
  endAllActiveLives,
  pauseLive,
  resumeLive,
  joinLive,
  leaveLive,
  likeLive,
  commentLive,
  sendGift
};
