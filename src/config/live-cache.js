/**
 * Live cache in Firebase RTDB when Supabase is unreachable.
 * When Supabase is back, sync pushes cache to Supabase and clears RTDB.
 */
import { supabase, isConfigured as isSupabaseConfigured } from './supabase.js';
import { getFirebaseRtdb, isFirebaseAdminReady } from './firebase.js';
import crypto from 'crypto';

const CACHE_PATH = 'lives_cache';

function isRtdbAvailable() {
  return isFirebaseAdminReady && Boolean(getFirebaseRtdb());
}

function cacheRef() {
  if (!isRtdbAvailable()) return null;
  const rtdb = getFirebaseRtdb();
  try {
    return rtdb.ref(CACHE_PATH);
  } catch (err) {
    return null;
  }
}

/**
 * Create a live record in RTDB cache. Returns same shape as Supabase row.
 */
async function createInCache(hostId, hostDisplayName = null) {
  const ref = cacheRef();
  if (!ref) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    host_id: hostId,
    host_display_name: hostDisplayName || null,
    status: 'live',
    viewers_count: 0,
    viewer_user_ids: [],
    total_likes: 0,
    total_gifts_amount: 0,
    created_at: now,
    ended_at: null
  };
  try {
    await ref.child(id).set(row);
    return row;
  } catch (err) {
    console.warn('live-cache createInCache failed:', err?.message || err);
    return null;
  }
}

/**
 * List lives from cache by status.
 */
async function listFromCache(status = 'live') {
  const ref = cacheRef();
  if (!ref) return [];
  try {
    const snap = await ref.once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    const list = Object.entries(val)
      .map(([id, row]) => ({ ...row, id }))
      .filter((row) => row.status === status)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return list;
  } catch (err) {
    console.warn('live-cache listFromCache failed:', err?.message || err);
    return [];
  }
}

/**
 * Get one live from cache. Returns null if not found.
 */
async function getFromCache(liveId) {
  const ref = cacheRef();
  if (!ref || !liveId) return null;
  try {
    const snap = await ref.child(liveId).once('value');
    const val = snap.val();
    if (!val) return null;
    return { ...val, id: liveId };
  } catch (err) {
    console.warn('live-cache getFromCache failed:', err?.message || err);
    return null;
  }
}

/**
 * Update fields of a cached live.
 */
async function updateInCache(liveId, updates) {
  const ref = cacheRef();
  if (!ref || !liveId) return false;
  try {
    await ref.child(liveId).update(updates);
    return true;
  } catch (err) {
    console.warn('live-cache updateInCache failed:', err?.message || err);
    return false;
  }
}

/**
 * Sync all cached lives to Supabase: insert row, run payout if ended, then remove from RTDB.
 */
async function syncCacheToSupabase() {
  if (!isSupabaseConfigured() || !supabase) return { synced: 0, errors: [] };
  const ref = cacheRef();
  if (!ref) return { synced: 0, errors: [] };
  let synced = 0;
  const errors = [];
  try {
    const snap = await ref.once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return { synced: 0, errors: [] };
    const entries = Object.entries(val);
    for (const [liveId, row] of entries) {
      try {
        const { error: insertErr } = await supabase.from('lives').upsert(
          [{
            id: row.id || liveId,
            host_id: row.host_id,
            status: row.status || 'live',
            viewers_count: Number(row.viewers_count) || 0,
            total_likes: Number(row.total_likes) || 0,
            total_gifts_amount: Number(row.total_gifts_amount) || 0,
            created_at: row.created_at,
            ended_at: row.ended_at || null
          }],
          { onConflict: 'id' }
        );
        if (insertErr) throw insertErr;
        if (row.status === 'ended' && row.host_id) {
          const total = Number(row.total_gifts_amount || 0);
          const companyShare = +(total * 0.3).toFixed(2);
          const hostShare = +(total * 0.7).toFixed(2);
          const hostId = row.host_id;
          // Use atomic RPC for wallet credit (consistent with SEC-03 fix)
          if (hostShare > 0) {
            await supabase.rpc('credit_wallet', { p_owner_id: hostId, p_amount: hostShare });
          }
          if (companyShare > 0) {
            await supabase.rpc('credit_wallet', { p_owner_id: 'company', p_amount: companyShare });
            await supabase.from('transactions').insert([{
              owner_id: 'company',
              type: 'company_commission',
              amount: companyShare,
              balance_after: companyShare,
              meta: { live_id: liveId, host_id: hostId }
            }]);
          }
        }
        await ref.child(liveId).remove();
        synced++;
      } catch (e) {
        errors.push({ liveId, message: e?.message || String(e) });
      }
    }
    if (synced > 0) console.log('live-cache: synced', synced, 'lives to Supabase');
    if (errors.length > 0) console.warn('live-cache: sync errors', errors);
  } catch (err) {
    console.warn('live-cache syncCacheToSupabase failed:', err?.message || err);
  }
  return { synced, errors };
}

async function addViewerToCachedLive(liveId, userId) {
  if (!userId) return { ok: false, duplicate: false, viewers_count: 0, viewer_user_ids: [] };
  const live = await getFromCache(liveId);
  if (!live) return { ok: false, duplicate: false, viewers_count: 0, viewer_user_ids: [] };
  const ids = Array.isArray(live.viewer_user_ids) ? [...live.viewer_user_ids] : [];
  if (ids.includes(userId)) {
    return { ok: true, duplicate: true, viewers_count: Number(live.viewers_count) || ids.length, viewer_user_ids: ids };
  }
  ids.push(userId);
  await updateInCache(liveId, { viewer_user_ids: ids, viewers_count: ids.length });
  return { ok: true, duplicate: false, viewers_count: ids.length, viewer_user_ids: ids };
}

async function removeViewerFromCachedLive(liveId, userId) {
  if (!userId) return { ok: false, viewers_count: 0, viewer_user_ids: [] };
  const live = await getFromCache(liveId);
  if (!live) return { ok: false, viewers_count: 0, viewer_user_ids: [] };
  const ids = Array.isArray(live.viewer_user_ids) ? live.viewer_user_ids.filter((id) => id !== userId) : [];
  const next = Math.max(0, ids.length);
  await updateInCache(liveId, { viewer_user_ids: ids, viewers_count: next });
  return { ok: true, viewers_count: next, viewer_user_ids: ids };
}

export {
  isRtdbAvailable,
  createInCache,
  listFromCache,
  getFromCache,
  updateInCache,
  syncCacheToSupabase,
  addViewerToCachedLive,
  removeViewerFromCachedLive
};
