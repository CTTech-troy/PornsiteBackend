/**
 * Firebase Auth Identity Toolkit REST (server-side only).
 * Uses FIREBASE_WEB_API_KEY from env — never expose this to the browser for auth flows.
 */

const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';

const MESSAGE_MAP = {
  EMAIL_NOT_FOUND: 'No account found for this email.',
  INVALID_EMAIL: 'Invalid email address.',
  INVALID_PASSWORD: 'Invalid email or password.',
  INVALID_LOGIN_CREDENTIALS: 'Invalid email or password.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled for this project.',
  PASSWORD_LOGIN_DISABLED: 'Email/password sign-in is not enabled for this project.',
};

export function mapIdentityToolkitMessage(raw) {
  const key = typeof raw === 'string' ? raw : '';
  if (MESSAGE_MAP[key]) return MESSAGE_MAP[key];
  if (key.includes('INVALID_LOGIN_CREDENTIALS')) return MESSAGE_MAP.INVALID_LOGIN_CREDENTIALS;
  return 'Invalid email or password.';
}

/**
 * @returns {Promise<{ idToken: string, refreshToken: string, localId: string, email: string }>}
 */
export async function signInWithPassword(email, password) {
  const apiKey = (process.env.FIREBASE_WEB_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('Authentication service is not configured.');
    err.code = 'AUTH_SERVICE_CONFIG';
    throw err;
  }
  const emailNorm = String(email ?? '').trim().toLowerCase();
  const passwordStr = String(password ?? '');
  if (!emailNorm || !passwordStr) {
    const err = new Error('Email and password are required.');
    err.code = 'VALIDATION';
    throw err;
  }

  const url = `${IDENTITY_BASE}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: emailNorm,
      password: passwordStr,
      returnSecureToken: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMsg = data?.error?.message || 'UNKNOWN_ERROR';
    const err = new Error(mapIdentityToolkitMessage(rawMsg));
    err.code = rawMsg;
    err.status = res.status;
    if (process.env.NODE_ENV === 'development') {
      console.warn('[firebaseAuthRest] signInWithPassword failed:', rawMsg);
    }
    throw err;
  }

  const idToken = data.idToken;
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Authentication response was incomplete.');
    err.code = 'INCOMPLETE_RESPONSE';
    throw err;
  }

  return {
    idToken,
    refreshToken: data.refreshToken || '',
    localId: data.localId || '',
    email: (data.email || emailNorm).trim().toLowerCase(),
  };
}
