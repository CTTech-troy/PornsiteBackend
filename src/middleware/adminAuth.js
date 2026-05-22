import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

function adminSelectColumns(includeNewColumns = true) {
  return includeNewColumns
    ? 'id,name,email,role,permissions,is_active,is_super_admin,last_login,last_active_at'
    : 'id,name,email,permissions,is_active,is_super_admin,last_login';
}

async function findAdminByTokenPayload(payload) {
  if (!supabase) return null;
  const ids = [];
  if (payload?.id) ids.push({ column: 'id', value: payload.id });
  if (payload?.email) ids.push({ column: 'email', value: String(payload.email).toLowerCase() });

  for (const lookup of ids) {
    let { data, error } = await supabase
      .from('admin_users')
      .select(adminSelectColumns(true))
      .eq(lookup.column, lookup.value)
      .maybeSingle();

    if (error && (error.code === '42703' || error.code === 'PGRST204' || String(error.message || '').includes('schema cache'))) {
      const fallback = await supabase
        .from('admin_users')
        .select(adminSelectColumns(false))
        .eq(lookup.column, lookup.value)
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) throw error;
    if (data) return data;
  }

  return null;
}

export async function resolveAdminSessionFromToken(token) {
  if (!token) return null;
  const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'admin-secret-fallback');
  let admin = payload;

  try {
    const data = await findAdminByTokenPayload(payload);
    if (!data || data.is_active === false) return null;
    admin = {
      ...payload,
      id: data.id || payload.id,
      name: data.name || payload.name || data.email,
      email: data.email || payload.email,
      role: data.role || (data.is_super_admin ? 'super_admin' : 'admin'),
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
      is_super_admin: data.is_super_admin === true,
    };
  } catch {
    /* Keep JWT payload when the admin table is temporarily unavailable. */
  }

  return admin;
}

export async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'admin-secret-fallback');
    let admin = payload;
    try {
      const data = await findAdminByTokenPayload(payload);
      if (!data) return res.status(401).json({ error: 'Admin session no longer exists. Please log in again.' });
      if (data.is_active === false) return res.status(401).json({ error: 'Admin account is inactive. Please contact the owner.' });
      admin = {
        ...payload,
        id: data.id || payload.id,
        name: data.name || payload.name || data.email,
        email: data.email || payload.email,
        role: data.role || (data.is_super_admin ? 'super_admin' : 'admin'),
        permissions: Array.isArray(data.permissions) ? data.permissions : [],
        is_super_admin: data.is_super_admin === true,
      };
      supabase
        .from('admin_users')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', payload.id)
        .then(() => null, () => null);
    } catch {
      /* Keep JWT payload when the admin table is temporarily unavailable. */
    }
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function attachAdminFromBearerToken(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.admin = jwt.verify(token, process.env.ADMIN_JWT_SECRET || 'admin-secret-fallback');
    } catch {
      req.admin = undefined;
    }
  }
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.admin?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });
  next();
}

export function requireFinanceAccess(req, res, next) {
  const role = String(req.admin?.role || '').toLowerCase();
  const permissions = Array.isArray(req.admin?.permissions) ? req.admin.permissions : [];
  const allowed = req.admin?.is_super_admin ||
    ['admin', 'finance', 'operations'].includes(role) ||
    permissions.includes('finance_hub') ||
    permissions.includes('creator_payouts');

  if (!allowed) {
    return res.status(403).json({ error: 'Finance access required' });
  }

  return next();
}

export function requireAiModerationAccess(req, res, next) {
  const role = String(req.admin?.role || '').toLowerCase();
  const permissions = Array.isArray(req.admin?.permissions) ? req.admin.permissions : [];
  const allowed = req.admin?.is_super_admin ||
    ['admin', 'moderator', 'operations', 'support'].includes(role) ||
    permissions.includes('ai_moderator') ||
    permissions.includes('/ai-moderator');

  if (!allowed) {
    return res.status(403).json({ error: 'AI moderation access required' });
  }

  return next();
}
