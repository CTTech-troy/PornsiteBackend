import fetch from 'node-fetch';

const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/**
 * Verifies email/password against Firebase Auth (same as client SDK sign-in).
 * Requires FIREBASE_WEB_API_KEY (same Web API key as the frontend Firebase config).
 */
export async function verifyFirebasePassword(email, password) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    const err = new Error('FIREBASE_WEB_API_KEY_NOT_SET');
    err.code = 'config';
    throw err;
  }

  const res = await fetch(`${SIGN_IN_URL}?key=${encodeURIComponent(apiKey.trim())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: String(email).trim().toLowerCase(),
      password: String(password),
      returnSecureToken: true,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error?.message || '';
    const err = new Error(mapFirebaseIdentityError(msg));
    if (
      msg.includes('INVALID_PASSWORD') ||
      msg.includes('INVALID_LOGIN_CREDENTIALS') ||
      msg.includes('EMAIL_NOT_FOUND')
    ) {
      err.code = 'auth/invalid-credential';
    } else if (msg.includes('TOO_MANY_ATTEMPTS') || msg.includes('QUOTA_EXCEEDED')) {
      err.code = 'auth/too-many-requests';
    } else {
      err.code = 'auth/internal-error';
    }
    throw err;
  }

  return {
    localId: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

function mapFirebaseIdentityError(message) {
  if (!message) return 'Invalid email or password.';
  if (message.includes('INVALID_PASSWORD') || message.includes('INVALID_LOGIN_CREDENTIALS')) {
    return 'Invalid email or password.';
  }
  if (message.includes('EMAIL_NOT_FOUND')) return 'Invalid email or password.';
  if (message.includes('USER_DISABLED')) return 'This account has been disabled.';
  if (message.includes('TOO_MANY_ATTEMPTS')) return 'Too many attempts. Try again later.';
  if (message.includes('QUOTA_EXCEEDED')) return 'Service temporarily unavailable. Try again later.';
  return 'Sign-in failed.';
}
