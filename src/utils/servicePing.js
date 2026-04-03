import { auth, firebaseInitialized } from '../config/firebase.js';
import { supabase, isConfigured } from '../config/supabase.js';

const STARTUP_CHECK_TIMEOUT_MS = 3500;

function envHasFirebaseCreds() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

function supabaseKeyLooksAnon() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(k && !k.startsWith('eyJ') && (k.includes('publishable') || k.includes('anon')));
}

export async function pingFirebase() {
  if (!envHasFirebaseCreds()) {
    return {
      id: 'firebase',
      status: 'not_configured',
      detail: 'missing FIREBASE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS'
    };
  }
  if (!firebaseInitialized) {
    return {
      id: 'firebase',
      status: 'inactive',
      detail: 'Admin SDK not initialized (credentials or FIREBASE_DATABASE_URL)'
    };
  }
  try {
    const fbRes = await Promise.race([
      auth.listUsers(1),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Firebase check timed out')), STARTUP_CHECK_TIMEOUT_MS)
      )
    ]);
    if (fbRes) {
      return { id: 'firebase', status: 'active', detail: 'Auth API reachable' };
    }
    return { id: 'firebase', status: 'inactive', detail: 'unexpected response' };
  } catch (err) {
    return { id: 'firebase', status: 'inactive', detail: err?.message || String(err) };
  }
}

export async function pingSupabase() {
  if (!isConfigured()) {
    return {
      id: 'supabase',
      status: 'not_configured',
      detail: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing'
    };
  }
  if (supabaseKeyLooksAnon()) {
    return {
      id: 'supabase',
      status: 'inactive',
      detail: 'use service_role key (not anon/publishable)'
    };
  }
  try {
    const supRes = await Promise.race([
      supabase.from('lives').select('id').limit(1),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Supabase check timed out')), STARTUP_CHECK_TIMEOUT_MS)
      )
    ]);
    if (supRes && !supRes.error) {
      return { id: 'supabase', status: 'active', detail: 'PostgREST reachable' };
    }
    const msg = supRes?.error?.message || String(supRes?.error || 'unknown error');
    return { id: 'supabase', status: 'inactive', detail: msg };
  } catch (err) {
    return { id: 'supabase', status: 'inactive', detail: err?.message || String(err) };
  }
}

export async function pingServices() {
  const [firebase, supabaseResult] = await Promise.all([pingFirebase(), pingSupabase()]);
  return { firebase, supabase: supabaseResult };
}
