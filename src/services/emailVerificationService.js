import crypto from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { getFirebaseAuth, getFirebaseDb } from '../config/firebase.js';
import { sendVerificationEmail } from './emailService.js';
import { buildAppVerificationUrl, isLocalDevUrlsConfigured } from '../utils/authPublicUrls.js';

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const LOG = '[emailVerification]';

export function isEmailVerifiedFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value ?? '').trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', 'f', '0', 'no', 'off', ''].includes(s)) return false;
  return null;
}

export function isLoginEmailVerifiedOk(userRecord, decoded, supaProfile, firestoreSnap) {
  const recordVerified = userRecord?.emailVerified === true;
  const supabaseVerified = isEmailVerifiedFlag(supaProfile?.emailVerified) === true;
  const claimsVerified =
    isEmailVerifiedFlag(decoded?.email_verified) === true ||
    isEmailVerifiedFlag(decoded?.emailVerified) === true;
  const firestoreVerified =
    firestoreSnap?.exists === true && firestoreSnap.data()?.emailVerified === true;
  return recordVerified || supabaseVerified || claimsVerified || firestoreVerified;
}

/**
 * Invalidate old tokens, mint a new one, send email (or local dev link).
 * Used by resend endpoint and by login when the account is not verified.
 */
export async function issueFreshVerificationEmail(uid, emailNorm, displayName) {
  const email = String(emailNorm || '').trim().toLowerCase();
  const name = String(displayName || email.split('@')[0] || 'User').trim() || 'User';

  if (!isConfigured() || !supabase) {
    return { ok: false, code: 'NO_DB', message: 'Verification service unavailable.' };
  }
  if (!uid || !email.includes('@')) {
    return { ok: false, code: 'INVALID', message: 'Invalid verification request.' };
  }

  await ensureVerificationUserRow(uid, email, name);

  const { data: userData } = await supabase
    .from('users')
    .select('email_verified')
    .eq('id', uid)
    .maybeSingle();

  if (isEmailVerifiedFlag(userData?.email_verified) === true) {
    return { ok: false, code: 'ALREADY_VERIFIED', message: 'This email is already verified.' };
  }

  const { data: recentToken } = await supabase
    .from('email_verification_tokens')
    .select('created_at')
    .eq('user_id', uid)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentToken) {
    const elapsedMs = Date.now() - new Date(recentToken.created_at).getTime();
    if (elapsedMs < 60_000) {
      const wait = Math.ceil((60_000 - elapsedMs) / 1000);
      return {
        ok: false,
        code: 'COOLDOWN',
        waitSeconds: wait,
        message: `Please wait ${wait} seconds before requesting another verification email.`,
      };
    }
  }

  await invalidateUnusedTokensForUser(uid);

  const created = await createVerificationToken(uid, email);
  if (!created.ok) {
    return {
      ok: false,
      code: 'TOKEN_FAIL',
      message: created.message || 'Could not issue a new verification link. Please try again later.',
    };
  }

  const verificationUrl = buildAppVerificationUrl(created.rawToken);
  const resendConfigured = !!String(process.env.RESEND_API_KEY || '').trim();

  if (resendConfigured) {
    try {
      await sendVerificationEmail({ to: email, name, verificationUrl });
      return { ok: true, code: 'SENT', message: 'Verification email sent. Please check your inbox.' };
    } catch (sendErr) {
      console.error(`${LOG} issueFresh send:`, sendErr?.message || sendErr);
      if (isLocalDevUrlsConfigured()) {
        return {
          ok: true,
          code: 'LOCAL_LINK',
          message: 'Email could not be sent. Use the verification link below (local development only).',
          localVerificationUrl: verificationUrl,
        };
      }
      return {
        ok: false,
        code: 'SEND_FAIL',
        message: sendErr?.message || 'Failed to send verification email.',
      };
    }
  }

  if (isLocalDevUrlsConfigured()) {
    return {
      ok: true,
      code: 'LOCAL_LINK',
      message: 'Email is not configured on this server. Use the link below (local development only).',
      localVerificationUrl: verificationUrl,
      emailDeliveryConfigured: false,
    };
  }

  return {
    ok: false,
    code: 'EMAIL_NOT_CONFIGURED',
    message: 'Verification email is not available (email service not configured).',
  };
}

function emailDomainOnly(email) {
  const i = String(email || '').indexOf('@');
  return i === -1 ? '(invalid)' : String(email).slice(i + 1, i + 1 + 64);
}

function normalizeRawToken(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  try {
    const once = decodeURIComponent(t);
    if (once !== t) t = once.trim();
  } catch {
    /* keep t */
  }
  return t.trim();
}

function isMissingVerificationUserError(error) {
  const msg = String(error?.message || '');
  return (
    error?.code === '23503' ||
    msg.includes('email_verification_tokens_user_id_fkey') ||
    /violates foreign key constraint/i.test(msg)
  );
}

function isSchemaColumnError(error) {
  const msg = String(error?.message || '');
  return (
    error?.code === 'PGRST204' ||
    error?.code === '42703' ||
    /column|schema cache|Could not find/i.test(msg)
  );
}

async function ensureVerificationUserRow(uid, email, displayName = '') {
  if (!isConfigured() || !supabase || !uid) return { ok: false };

  try {
    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('id')
      .eq('id', uid)
      .maybeSingle();
    if (!lookupError && existing?.id) return { ok: true, existing: true };
  } catch {
    /* continue and try to upsert below */
  }

  const emailNorm = String(email || '').trim().toLowerCase();
  const name =
    String(displayName || '').trim() ||
    (emailNorm.includes('@') ? emailNorm.split('@')[0] : '') ||
    'User';
  const nowIso = new Date().toISOString();
  const username = name.replace(/\s+/g, '_').toLowerCase().slice(0, 80) || String(uid).slice(0, 80);
  const avatar = emailNorm
    ? `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(emailNorm)}`
    : null;

  const attempts = [
    {
      id: uid,
      username,
      display_name: name,
      full_name: name,
      email: emailNorm,
      email_verified: false,
      creator: false,
      role: 'user',
      created_at: nowIso,
      updated_at: nowIso,
      ...(avatar ? { avatar, avatar_url: avatar } : {}),
    },
    {
      id: uid,
      username,
      email: emailNorm,
      email_verified: false,
      creator: false,
      created_at: nowIso,
      updated_at: nowIso,
    },
    { id: uid },
  ];

  for (const row of attempts) {
    const { error } = await supabase.from('users').upsert(row, { onConflict: 'id' });
    if (!error) {
      if (!Object.prototype.hasOwnProperty.call(row, 'email_verified')) {
        try {
          await supabase.from('users').update({ email_verified: false }).eq('id', uid);
        } catch {
          /* best effort for legacy schemas */
        }
      }
      return { ok: true };
    }

    if (!isSchemaColumnError(error)) {
      console.warn(`${LOG} ensure user row failed`, uid, error.message);
      return { ok: false, error };
    }
  }

  return { ok: false };
}

async function markSupabaseEmailVerified(uid, nowIso) {
  const attempts = [
    { email_verified: true, email_verified_at: nowIso },
    { email_verified: true },
  ];
  let lastError = null;

  for (const patch of attempts) {
    const { error } = await supabase.from('users').update(patch).eq('id', uid);
    if (!error) return { ok: true };

    lastError = error;
    if (!isSchemaColumnError(error)) {
      return { ok: false, error };
    }
  }

  return { ok: false, error: lastError, missingColumns: true };
}

export async function applyEmailVerificationForUid(uid) {
  if (!isConfigured() || !supabase) {
    return { ok: false, message: 'Service temporarily unavailable.', code: 'SERVICE' };
  }
  if (!uid) return { ok: false, message: 'Invalid verification request.', code: 'INVALID' };

  const nowIso = new Date().toISOString();
  const supabaseResult = await markSupabaseEmailVerified(uid, nowIso);
  if (!supabaseResult.ok) {
    console.warn(`${LOG} apply users update failed`, supabaseResult.error?.message || 'unknown error');
  }

  let firebaseAuthUpdated = false;
  try {
    const auth = getFirebaseAuth();
    if (auth) {
      await auth.updateUser(uid, { emailVerified: true });
      firebaseAuthUpdated = true;
    }
  } catch (fbErr) {
    console.warn(`${LOG} Firebase updateUser emailVerified:`, fbErr?.message);
  }

  let firestoreUpdated = false;
  try {
    const db = getFirebaseDb();
    if (db) {
      await db.collection('users').doc(uid).set(
        { emailVerified: true, updatedAt: nowIso },
        { merge: true }
      );
      firestoreUpdated = true;
    }
  } catch (firestoreErr) {
    console.warn(`${LOG} Firestore emailVerified:`, firestoreErr?.message);
  }

  if (!supabaseResult.ok && !firebaseAuthUpdated && !firestoreUpdated) {
    return { ok: false, message: 'Could not update verification status.', code: 'DB_UPDATE' };
  }

  return {
    ok: true,
    message: 'Email verified successfully. You can now log in.',
    code: supabaseResult.ok ? 'OK' : 'OK_PARTIAL',
  };
}

export async function invalidateUnusedTokensForUser(uid) {
  if (!isConfigured() || !supabase || !uid) return { ok: true };
  const { error } = await supabase
    .from('email_verification_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', uid)
    .is('used_at', null);
  if (error) console.warn(`${LOG} invalidate tokens`, uid, error.message);
  return { ok: !error, error };
}

export async function createVerificationToken(uid, email) {
  if (!isConfigured() || !supabase) {
    console.error(`${LOG} createToken skipped: Supabase not configured`);
    return { ok: false, code: 'NO_DB', message: 'Verification service unavailable.' };
  }
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!uid || !emailNorm.includes('@')) {
    return { ok: false, code: 'INVALID', message: 'Invalid verification request.' };
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  let { error } = await supabase.from('email_verification_tokens').insert({
    user_id: uid,
    email: emailNorm,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
  });

  if (error && isMissingVerificationUserError(error)) {
    console.warn(`${LOG} token parent user missing; repairing uid=${uid} domain=${emailDomainOnly(emailNorm)}`);
    const ensured = await ensureVerificationUserRow(uid, emailNorm);
    if (ensured.ok) {
      ({ error } = await supabase.from('email_verification_tokens').insert({
        user_id: uid,
        email: emailNorm,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      }));
    }
  }

  if (error) {
    console.error(`${LOG} token insert failed uid=${uid} domain=${emailDomainOnly(emailNorm)}`, error.message);
    return { ok: false, code: 'INSERT_FAILED', message: error.message || 'Could not create verification token.' };
  }

  console.info(`${LOG} token created uid=${uid} domain=${emailDomainOnly(emailNorm)} expires=${expiresAt.toISOString()}`);
  return { ok: true, rawToken, expiresAt };
}

export async function consumeVerificationToken(rawInput) {
  const token = normalizeRawToken(rawInput);
  if (!token) {
    console.info(`${LOG} consume rejected: empty token`);
    return { ok: false, code: 'MISSING', message: 'Verification token is required.' };
  }
  if (!isConfigured() || !supabase) {
    return { ok: false, code: 'NO_DB', message: 'Service temporarily unavailable.' };
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const { data: tokenRecord, error } = await supabase
    .from('email_verification_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    console.warn(`${LOG} consume lookup error`, error.message);
    return { ok: false, code: 'DB_ERROR', message: 'Verification link is invalid or has expired.' };
  }
  if (!tokenRecord) {
    console.info(`${LOG} consume not_found hash_prefix=${tokenHash.slice(0, 8)}…`);
    return { ok: false, code: 'NOT_FOUND', message: 'Verification link is invalid or has expired.' };
  }
  if (tokenRecord.used_at) {
    console.info(`${LOG} consume already_used id=${tokenRecord.id}`);
    return { ok: false, code: 'USED', message: 'This verification link has already been used.' };
  }
  if (new Date(tokenRecord.expires_at) < new Date()) {
    console.info(`${LOG} consume expired id=${tokenRecord.id}`);
    return { ok: false, code: 'EXPIRED', message: 'Verification link has expired. Please request a new one.' };
  }

  const uid = tokenRecord.user_id;
  const applied = await applyEmailVerificationForUid(uid);
  if (!applied.ok) {
    console.warn(`${LOG} consume apply failed`, applied.code, uid);
    return { ok: false, code: applied.code || 'APPLY_FAILED', message: applied.message };
  }

  await supabase.from('email_verification_tokens').update({
    used_at: new Date().toISOString(),
  }).eq('id', tokenRecord.id);

  console.info(`${LOG} consume success uid=${uid}`);
  return { ok: true, code: 'OK', message: applied.message, uid };
}
