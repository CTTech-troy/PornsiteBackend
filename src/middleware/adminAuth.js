import jwt from 'jsonwebtoken';

export function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'admin-secret-fallback');
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireSuperAdmin(req, res, next) {
  if (!req.admin?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });
  next();
}
