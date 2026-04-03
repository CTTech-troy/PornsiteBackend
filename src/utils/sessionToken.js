import jwt from 'jsonwebtoken';
import { getFirebaseAuth } from '../config/firebase.js';

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
  return jwt.sign({ uid, email: email || '' }, secret, { expiresIn: '7d' });
}

/**
 * Firebase ID token (client SDK) or app session JWT (login/signup).
 */
export async function resolveUidFromBearerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const authSvc = getFirebaseAuth();
  if (authSvc) {
    try {
      const decoded = await authSvc.verifyIdToken(token);
      return decoded.uid;
    } catch {
      /* fall through to session JWT */
    }
  } else {
    /* Admin SDK unavailable — only session JWT may work */
  }
  const secret = getSecret();
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    return typeof payload?.uid === 'string' ? payload.uid : null;
  } catch {
    return null;
  }
}

export { getSecret };
