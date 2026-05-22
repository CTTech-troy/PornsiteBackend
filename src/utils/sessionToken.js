import jwt from 'jsonwebtoken';
import { getFirebaseAuth, markFirebaseAdminUnavailable } from '../config/firebase.js';

function getSecret() {
  const s = process.env.JWT_SECRET || process.env.SESSION_JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV !== 'production') {
    return 'letstream-dev-only-session-secret';
  }
  return null;
}

export function mintSessionToken(uid, email) {
  if (!uid) return null;
  const secret = getSecret();
  if (!secret) return null;
  // MED-03: Reduced session expiry from 7d to 24h
  return jwt.sign({ uid, email: email || '' }, secret, { expiresIn: '24h' });
}

/**
 * Firebase ID token (client SDK) or app session JWT (login/signup).
 */
export async function resolveUidFromBearerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const authSvc = getFirebaseAuth();
  if (authSvc) {
    try {
      const decoded = await authSvc.verifyIdToken(token, true);
      return decoded.uid;
    } catch (err) {
      markFirebaseAdminUnavailable(err, 'verify Firebase ID token');
      /* fall through to session JWT */
    }
  } else {
    /* Admin SDK unavailable — only session JWT may work */
  }
  const secret = getSecret();
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    const uid = typeof payload?.uid === 'string' ? payload.uid : null;
    if (!uid) return null;
    if (authSvc) {
      try {
        const user = await authSvc.getUser(uid);
        if (user.disabled) return null;
      } catch (err) {
        markFirebaseAdminUnavailable(err, 'load Firebase session user');
        return null;
      }
    }
    return uid;
  } catch {
    return null;
  }
}

export { getSecret };
