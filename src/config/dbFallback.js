import { supabase, isConfigured } from './supabase.js';
import { rtdb } from './firebase.js';

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

/** Quick check: is Supabase reachable right now? */
async function isSupabaseReachable() {
  if (!isConfigured() || !supabase) return false;
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    return !error;
  } catch (err) {
    return false;
  }
}

async function insertUser(user) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('users').upsert([user], { onConflict: 'id' });
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase insertUser failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  // RTDB fallback: write under /users/{id}
  try {
    const id = user.id || user.id === 0 ? user.id : (user.id = user.id || (user.uid || Date.now().toString()));
    await rtdb.ref(`users/${id}`).set(user);
    return { source: 'rtdb', data: user };
  } catch (err) {
    console.error('RTDB insertUser failed:', err);
    throw err;
  }
}

async function insertCreatorApplication(payload) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('creator_applications').insert([payload]);
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase insertCreatorApplication failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    await rtdb.ref(`creator_applications/${payload.id}`).set(payload);
    return { source: 'rtdb', data: payload };
  } catch (err) {
    console.error('RTDB insertCreatorApplication failed:', err);
    throw err;
  }
}

async function getUserCreatorStatus(userId) {
  if (isConfigured() && isUuidLike(userId)) {
    try {
      const { data, error } = await supabase.from('users').select('creator, verified').eq('id', userId).maybeSingle();
      if (!error && data) return { creator: !!data.creator, creatorStatus: data.verified === 'approved' ? 'approved' : data.verified === 'rejected' ? 'rejected' : data.verified === 'pending' ? 'pending' : 'none' };
    } catch (err) {
      // ignore
    }
  }
  try {
    const snap = await rtdb.ref(`users/${userId}`).once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') {
      return { creator: false, creatorStatus: 'none' };
    }
    const creator = !!val.creator;
    const rawStatus = val.creatorStatus ?? val.verified;
    const creatorStatus =
      typeof rawStatus === 'string' ? rawStatus : creator ? 'approved' : 'none';
    return { creator, creatorStatus };
  } catch (err) {
    return { creator: false, creatorStatus: 'none' };
  }
}

async function updateUserCreatorStatus(userId, approve) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('users').update({
        creator: !!approve,
        verified: approve ? 'approved' : 'rejected',
      }).eq('id', userId);
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase updateUserCreatorStatus failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    await rtdb.ref(`users/${userId}/creator`).set(!!approve);
    await rtdb.ref(`users/${userId}/creatorStatus`).set(approve ? 'approved' : 'rejected');
    await rtdb.ref(`users/${userId}/verified`).set(approve ? 'approved' : 'rejected');
    return { source: 'rtdb', data: { userId, creator: !!approve } };
  } catch (err) {
    console.error('RTDB updateUserCreatorStatus failed:', err);
    throw err;
  }
}

async function updateUserWithCreatorApplication(userId, creatorApplicationData) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('users').update({
        creator_application: creatorApplicationData || {},
        verified: 'pending',
        creator: false,
      }).eq('id', userId);
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase updateUserWithCreatorApplication failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    await rtdb.ref(`users/${userId}/creator_application`).set(creatorApplicationData || {});
    await rtdb.ref(`users/${userId}/verified`).set('pending');
    await rtdb.ref(`users/${userId}/creatorStatus`).set('pending');
    return { source: 'rtdb', data: { userId, verified: 'pending' } };
  } catch (err) {
    console.error('RTDB updateUserWithCreatorApplication failed:', err);
    throw err;
  }
}

async function insertMedia(metadata) {
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('media').insert([metadata]);
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase insertMedia failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    const id = metadata.id || Date.now().toString();
    await rtdb.ref(`media/${id}`).set(metadata);
    return { source: 'rtdb', data: metadata };
  } catch (err) {
    console.error('RTDB insertMedia failed:', err);
    throw err;
  }
}

async function getPublicProfile(userId) {
  if (!userId) return null;
  const rawId = String(userId).trim();
  // Supabase users.id is UUID in this project; Firebase UIDs should go to RTDB fallback.
  if (isConfigured() && isUuidLike(rawId)) {
    try {
      // Select only columns that typically exist (followers may not exist; return 0)
      const { data, error } = await supabase.from('users').select('id, username').eq('id', rawId).maybeSingle();
      if (error) throw error;
      if (data) return { id: data.id, displayName: data.username || data.id, followers: 0 };
      return null;
    } catch (err) {
      console.warn('Supabase getPublicProfile failed:', err && err.message ? err.message : err);
    }
  }
  try {
    const snap = await rtdb.ref(`users/${rawId}`).once('value');
    const val = snap.val();
    if (!val) return null;
    return { id: rawId, displayName: val.username || val.displayName || rawId, followers: Number(val.followers) || 0 };
  } catch (err) {
    return null;
  }
}

async function incrementFollow(userId) {
  if (!userId) throw new Error('missing userId');
  if (isConfigured()) {
    try {
      // users.followers may not exist; if so, fall through to RTDB
      const { data: row, error: fetchErr } = await supabase.from('users').select('followers').eq('id', userId).maybeSingle();
      if (fetchErr) throw fetchErr;
      const next = (Number(row?.followers) || 0) + 1;
      const { error: updateErr } = await supabase.from('users').update({ followers: next }).eq('id', userId);
      if (updateErr) throw updateErr;
      return { followers: next };
    } catch (err) {
      const msg = err?.message || String(err);
      if (/column.*does not exist|followers/i.test(msg)) {
        // Supabase users table has no followers column; use RTDB
      } else {
        console.warn('Supabase incrementFollow failed:', msg);
      }
    }
  }
  try {
    const ref = rtdb.ref(`users/${userId}/followers`);
    const snap = await ref.once('value');
    const next = (Number(snap.val()) || 0) + 1;
    await ref.set(next);
    return { followers: next };
  } catch (err) {
    console.error('RTDB incrementFollow failed:', err);
    throw err;
  }
}

/**
 * When Supabase is back up, push all data that was written to RTDB (fallback) into Supabase.
 * Call periodically (e.g. every 2 min) from the server.
 */
async function syncRtdbToSupabase() {
  if (!isConfigured()) return { users: 0, creator_applications: 0, media: 0 };
  const hasRtdb = Boolean(process.env.FIREBASE_DATABASE_URL);
  if (!hasRtdb) return { users: 0, creator_applications: 0, media: 0 };

  const ok = await isSupabaseReachable();
  if (!ok) return { users: 0, creator_applications: 0, media: 0 };

  let usersSynced = 0;
  let applicationsSynced = 0;
  let mediaSynced = 0;

  try {
    const usersSnap = await rtdb.ref('users').once('value');
    const usersVal = usersSnap.val();
    if (usersVal && typeof usersVal === 'object') {
      const rows = Object.entries(usersVal).map(([id, v]) => {
        const o = typeof v === 'object' && v !== null ? v : {};
        return {
          id: id,
          username: o.username ?? o.displayName ?? o.email ?? id,
          creator: !!o.creator,
          verified: o.verified ?? o.creatorStatus ?? null,
          creator_application: o.creator_application ?? null,
        };
      });
      if (rows.length > 0) {
        const { error } = await supabase.from('users').upsert(rows, { onConflict: 'id' });
        if (!error) usersSynced = rows.length;
      }
    }
  } catch (err) {
    console.warn('syncRtdbToSupabase users:', err?.message || err);
  }

  try {
    const appSnap = await rtdb.ref('creator_applications').once('value');
    const appVal = appSnap.val();
    if (appVal && typeof appVal === 'object') {
      const rows = Object.entries(appVal).map(([id, v]) => ({ ...(typeof v === 'object' && v ? v : {}), id }));
      if (rows.length > 0) {
        const { error } = await supabase.from('creator_applications').upsert(rows, { onConflict: 'id' });
        if (!error) applicationsSynced = rows.length;
      }
    }
  } catch (err) {
    console.warn('syncRtdbToSupabase creator_applications:', err?.message || err);
  }

  try {
    const mediaSnap = await rtdb.ref('media').once('value');
    const mediaVal = mediaSnap.val();
    if (mediaVal && typeof mediaVal === 'object') {
      const rows = Object.entries(mediaVal).map(([id, v]) => ({ ...(typeof v === 'object' && v ? v : {}), id: id }));
      if (rows.length > 0) {
        const { error } = await supabase.from('media').upsert(rows, { onConflict: 'id' });
        if (!error) mediaSynced = rows.length;
      }
    }
  } catch (err) {
    console.warn('syncRtdbToSupabase media:', err?.message || err);
  }

  if (usersSynced > 0 || applicationsSynced > 0 || mediaSynced > 0) {
    console.log('RTDB → Supabase sync:', { users: usersSynced, creator_applications: applicationsSynced, media: mediaSynced });
  }
  return { users: usersSynced, creator_applications: applicationsSynced, media: mediaSynced };
}

export { insertUser, insertCreatorApplication, getUserCreatorStatus, updateUserCreatorStatus, updateUserWithCreatorApplication, insertMedia, getPublicProfile, incrementFollow, syncRtdbToSupabase, isSupabaseReachable };

async function getMediaByUser(userId) {
  if (!userId) return [];
  if (isConfigured()) {
    try {
      const { data, error } = await supabase.from('media').select('*').eq('user_id', userId);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('Supabase getMediaByUser failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    const snap = await rtdb.ref('media').orderByChild('user_id').equalTo(userId).once('value');
    const val = snap.val();
    if (!val) return [];
    return Object.keys(val).map(k => val[k]);
  } catch (err) {
    console.error('RTDB getMediaByUser failed:', err);
    throw err;
  }
}

export { getMediaByUser };
