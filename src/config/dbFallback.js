import { supabase } from './supabase.js';
import { rtdb } from './firebase.js';

function supabaseConfigured() {
  // supabase client will be created even if env missing; check URL/key presence
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function insertUser(user) {
  if (supabaseConfigured()) {
    try {
      const { data, error } = await supabase.from('users').insert([user]);
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
  if (supabaseConfigured()) {
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

async function updateUserCreatorStatus(userId, approve) {
  if (supabaseConfigured()) {
    try {
      const { data, error } = await supabase.from('users').update({ creator: !!approve }).eq('id', userId);
      if (error) throw error;
      return { source: 'supabase', data };
    } catch (err) {
      console.warn('Supabase updateUserCreatorStatus failed, falling back to RTDB:', err && err.message ? err.message : err);
    }
  }

  try {
    await rtdb.ref(`users/${userId}/creator`).set(!!approve);
    await rtdb.ref(`users/${userId}/creatorStatus`).set(approve ? 'approved' : 'rejected');
    return { source: 'rtdb', data: { userId, creator: !!approve } };
  } catch (err) {
    console.error('RTDB updateUserCreatorStatus failed:', err);
    throw err;
  }
}

async function insertMedia(metadata) {
  if (supabaseConfigured()) {
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

export { insertUser, insertCreatorApplication, updateUserCreatorStatus, insertMedia };
 
async function getMediaByUser(userId) {
  if (!userId) return [];
  if (supabaseConfigured()) {
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
