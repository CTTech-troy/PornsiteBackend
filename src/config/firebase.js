import path from 'path';
import fs from 'fs';
import dns from 'dns/promises';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

let credentialSourceUsed = '';
let gacMissingFileLogged = false;

(function normalizeFirebaseDatabaseUrl() {
  const raw = process.env.FIREBASE_DATABASE_URL;
  if (raw == null || typeof raw !== 'string') return;
  let u = raw.trim().replace(/\/+$/, '');
  if (!u) {
    delete process.env.FIREBASE_DATABASE_URL;
    return;
  }
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  process.env.FIREBASE_DATABASE_URL = u;
})();

function resolvedPathFromEnv(envVal) {
  const raw = (envVal || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const gacRawInitial = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
if (gacRawInitial && !path.isAbsolute(gacRawInitial)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(process.cwd(), gacRawInitial);
}

function resolvedGacPath() {
  const p = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

if (gacRawInitial) {
  const gacAbs = resolvedGacPath();
  if (!fs.existsSync(gacAbs)) {
    if (!gacMissingFileLogged) {
      gacMissingFileLogged = true;
      console.warn(
        '[Firebase Admin] GOOGLE_APPLICATION_CREDENTIALS points to a missing file — ignoring and trying other sources:',
        gacAbs
      );
    }
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
}

function readJsonFileSafe(absPath) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Env JSON often stores private_key with literal \n — convert to real newlines.
 */
function normalizeServiceAccountObject(o) {
  if (!o || typeof o !== 'object') return null;
  const out = { ...o };
  if (typeof out.private_key === 'string') {
    out.private_key = out.private_key.replace(/\\n/g, '\n');
  }
  if (out.type !== 'service_account') return null;
  if (!out.project_id || typeof out.project_id !== 'string') return null;
  if (!out.client_email || typeof out.client_email !== 'string') return null;
  if (!out.private_key || typeof out.private_key !== 'string') return null;
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(out.private_key)) return null;
  return out;
}

function tryParseJsonCredential(raw, sourceLabel) {
  const s = (raw || '').trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    const norm = normalizeServiceAccountObject(o);
    if (!norm) return null;
    return { account: norm, source: sourceLabel, credential: admin.credential.cert(norm) };
  } catch {
    return null;
  }
}

/**
 * Order: FIREBASE_SERVICE_ACCOUNT_KEY → FIREBASE_SERVICE_ACCOUNT_BASE64 → FIREBASE_SERVICE_ACCOUNT_PATH → GOOGLE_APPLICATION_CREDENTIALS (file must exist).
 */
function resolveAdminCredential() {
  const keyRaw = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  const fromKey = tryParseJsonCredential(keyRaw, 'FIREBASE_SERVICE_ACCOUNT_KEY');
  if (fromKey) return fromKey;

  const altRaw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  const fromAlt = tryParseJsonCredential(altRaw, 'FIREBASE_SERVICE_ACCOUNT');
  if (fromAlt) return fromAlt;

  const b64 = (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  if (b64) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf8');
      const o = JSON.parse(json);
      const norm = normalizeServiceAccountObject(o);
      if (norm) {
        return {
          account: norm,
          source: 'FIREBASE_SERVICE_ACCOUNT_BASE64',
          credential: admin.credential.cert(norm),
        };
      }
    } catch {
      /* ignore */
    }
  }

  const pathEnv = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  if (pathEnv) {
    const abs = resolvedPathFromEnv(pathEnv);
    if (abs && fs.existsSync(abs)) {
      const o = readJsonFileSafe(abs);
      const norm = normalizeServiceAccountObject(o);
      if (norm) {
        return {
          account: norm,
          source: 'FIREBASE_SERVICE_ACCOUNT_PATH',
          credential: admin.credential.cert(norm),
        };
      }
    } else if (pathEnv && !fs.existsSync(abs)) {
      console.warn('[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_PATH file not found:', abs || pathEnv);
    }
  }

  const gac = resolvedGacPath();
  if (gac && fs.existsSync(gac)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = gac;
    const o = readJsonFileSafe(gac);
    const norm = normalizeServiceAccountObject(o);
    if (norm) {
      return {
        account: norm,
        source: 'GOOGLE_APPLICATION_CREDENTIALS',
        credential: admin.credential.cert(norm),
      };
    }
    console.warn('[Firebase Admin] GOOGLE_APPLICATION_CREDENTIALS file exists but is not a valid service account JSON:', gac);
  }

  return null;
}

let firebaseInitialized = false;
let initFailureReason = '';
let firebaseAdminUnavailableUntil = 0;
let firebaseAdminLastWarnAt = 0;
const FIREBASE_NETWORK_COOLDOWN_MS = Number(process.env.FIREBASE_NETWORK_COOLDOWN_MS || 120000);
const FIREBASE_NETWORK_CHECK_TIMEOUT_MS = Number(process.env.FIREBASE_NETWORK_CHECK_TIMEOUT_MS || 2500);
const FIREBASE_OAUTH_HOST = 'accounts.google.com';

/** @type {import('firebase-admin/auth').Auth | null} */
let auth = null;
/** @type {FirebaseFirestore.Firestore | null} */
let db = null;
/** @type {import('firebase-admin/database').Database | null} */
let rtdb = null;

function isFirebaseNetworkError(err) {
  const msg = String(err?.message || err || '');
  return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|accounts\.google\.com/i.test(msg);
}

export function markFirebaseAdminUnavailable(err, context = 'Firebase Admin') {
  if (!isFirebaseNetworkError(err)) return false;
  firebaseAdminUnavailableUntil = Date.now() + FIREBASE_NETWORK_COOLDOWN_MS;
  const now = Date.now();
  if (!firebaseAdminLastWarnAt || now - firebaseAdminLastWarnAt > FIREBASE_NETWORK_COOLDOWN_MS) {
    firebaseAdminLastWarnAt = now;
    console.warn(
      `[Firebase Admin] Temporarily unavailable during ${context}: ${err?.message || err}. ` +
      `Skipping Firebase calls for ${Math.ceil(FIREBASE_NETWORK_COOLDOWN_MS / 1000)}s.`
    );
  }
  return true;
}

export function isFirebaseAdminUsable() {
  return firebaseInitialized && Date.now() >= firebaseAdminUnavailableUntil;
}

async function lookupWithTimeout(hostname) {
  let timer;
  try {
    return await Promise.race([
      dns.lookup(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timeout for ${hostname}`)), FIREBASE_NETWORK_CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureFirebaseAdminUsable(context = 'Firebase Admin') {
  if (!firebaseInitialized) return false;
  if (Date.now() < firebaseAdminUnavailableUntil) return false;
  try {
    await lookupWithTimeout(FIREBASE_OAUTH_HOST);
    return true;
  } catch (err) {
    markFirebaseAdminUnavailable(err, context);
    return false;
  }
}

try {
  const hasDbUrl = Boolean((process.env.FIREBASE_DATABASE_URL || '').trim());
  const resolved = resolveAdminCredential();

  if (!hasDbUrl) {
    initFailureReason = 'missing FIREBASE_DATABASE_URL';
    console.warn('[Firebase Admin] Skipped:', initFailureReason);
  } else if (!resolved) {
    initFailureReason = 'no valid service account (see startup summary for required env vars)';
    console.warn('[Firebase Admin] Skipped:', initFailureReason);
  } else {
    credentialSourceUsed = resolved.source;
    try {
      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: resolved.credential,
          databaseURL: process.env.FIREBASE_DATABASE_URL,
        });
      }
      db = admin.firestore();
      auth = admin.auth();
      rtdb = admin.database();
      firebaseInitialized = true;
      console.log('[Firebase Admin] Initialized using:', credentialSourceUsed);
    } catch (initErr) {
      initFailureReason = initErr?.message || String(initErr);
      credentialSourceUsed = '';
      console.warn('[Firebase Admin] initializeApp failed:', initFailureReason);
    }
  }
} catch (err) {
  initFailureReason = err?.message || String(err);
  console.warn('[Firebase Admin] Unexpected setup error:', initFailureReason);
}

export function getFirebaseAuth() {
  if (!isFirebaseAdminUsable()) return null;
  return auth;
}

export function getFirebaseDb() {
  if (!isFirebaseAdminUsable()) return null;
  return db;
}

export function getFirebaseRtdb() {
  if (!isFirebaseAdminUsable()) return null;
  return rtdb;
}

export function isRtdbSyncEnabled() {
  return isFirebaseAdminUsable() && rtdb != null && Boolean((process.env.FIREBASE_DATABASE_URL || '').trim());
}

export {
  admin,
  auth,
  db,
  rtdb,
  firebaseInitialized,
  firebaseInitialized as isFirebaseReady,
  firebaseInitialized as isFirebaseAdminReady,
};

export function getFirebaseInitDetail() {
  if (firebaseInitialized) {
    if (!isFirebaseAdminUsable()) {
      return {
        ok: false,
        reason: `temporarily unavailable until ${new Date(firebaseAdminUnavailableUntil).toISOString()}`,
        credentialSource: credentialSourceUsed,
      };
    }
    return { ok: true, reason: '', credentialSource: credentialSourceUsed };
  }
  return { ok: false, reason: initFailureReason || 'not initialized', credentialSource: '' };
}

function listMissingFirebaseEnvHints() {
  const missing = [];
  const hasDb = Boolean((process.env.FIREBASE_DATABASE_URL || '').trim());
  if (!hasDb) missing.push('FIREBASE_DATABASE_URL');

  const hasKey = Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim());
  const hasB64 = Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim());
  const pathSet = Boolean((process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim());
  let pathExists = false;
  if (pathSet) {
    const p = resolvedPathFromEnv(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '');
    pathExists = Boolean(p && fs.existsSync(p));
  }
  let gacInitialAbs = '';
  if (gacRawInitial) {
    const t = gacRawInitial.trim();
    gacInitialAbs = path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
  }
  const gacExists = Boolean(gacInitialAbs && fs.existsSync(gacInitialAbs));

  const hasUsableCreds = hasKey || hasB64 || pathExists || gacExists;
  if (!hasUsableCreds && !firebaseInitialized) {
    missing.push(
      'one of: FIREBASE_SERVICE_ACCOUNT_KEY (JSON string), FIREBASE_SERVICE_ACCOUNT_BASE64, FIREBASE_SERVICE_ACCOUNT_PATH (existing file), or GOOGLE_APPLICATION_CREDENTIALS (existing file)'
    );
  }
  return missing;
}

export function printFirebaseStartupSummary() {
  const hasDbUrl = Boolean((process.env.FIREBASE_DATABASE_URL || '').trim());
  const webKey = Boolean((process.env.FIREBASE_WEB_API_KEY || '').trim());

  console.log('[Startup] Firebase Database URL:', hasDbUrl ? 'present' : 'missing — set FIREBASE_DATABASE_URL');
  console.log(
    '[Startup] Firebase Admin credentials source:',
    firebaseInitialized && credentialSourceUsed ? credentialSourceUsed : 'none (Admin inactive)'
  );
  console.log('[Startup] Firebase Admin status:', isFirebaseAdminUsable() ? 'active' : `inactive (${getFirebaseInitDetail().reason || initFailureReason || 'unknown'})`);
  console.log('[Startup] RTDB → Supabase sync:', isRtdbSyncEnabled() ? 'enabled' : 'skipped (Firebase Admin or RTDB unavailable)');

  const hints = listMissingFirebaseEnvHints();
  if (!firebaseInitialized && hints.length) {
    console.log('[Startup] Still needed for Firebase Admin + RTDB:', hints.join('; '));
  }

  console.log('[Startup] Firebase Auth REST (FIREBASE_WEB_API_KEY):', webKey ? 'set' : 'missing');
}
