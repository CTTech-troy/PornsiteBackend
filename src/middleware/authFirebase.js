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
