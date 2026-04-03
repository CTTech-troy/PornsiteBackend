import { resolveUidFromBearerToken } from '../utils/sessionToken.js';

/**
 * Verify Authorization: Bearer <token> (Firebase ID token or app session JWT).
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  const uid = await resolveUidFromBearerToken(token);
  if (!uid) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
  req.uid = uid;
  return next();
}

/** Sets req.uid when Bearer token is valid; otherwise req.uid is undefined. */
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.uid = undefined;
    return next();
  }
  const token = authHeader.slice(7);
  const uid = await resolveUidFromBearerToken(token);
  req.uid = uid || undefined;
  return next();
}
