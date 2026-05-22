import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';

const auditEvents = new EventEmitter();
auditEvents.setMaxListeners(200);

const SENSITIVE_KEYS = /password|token|secret|key|authorization|cookie|session|jwt|hash|otp|code/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, val]) => (
    SENSITIVE_KEYS.test(key) ? [key, '[redacted]'] : [key, redact(val, depth + 1)]
  )));
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.ip || req?.socket?.remoteAddress || null;
}

function deviceFromAgent(userAgent = '') {
  const ua = String(userAgent || '');
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    'Unknown browser';
  const platform =
    /Android/i.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
    /Windows/i.test(ua) ? 'Windows' :
    /Macintosh|Mac OS/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' :
    'Unknown OS';
  return `${browser} on ${platform}`;
}

function actionTypeFor(action = '', targetType = '') {
  const value = `${action} ${targetType}`.toLowerCase();
  if (value.includes('login')) return 'auth_login';
  if (value.includes('logout')) return 'auth_logout';
  if (value.includes('payout') || value.includes('finance') || value.includes('payment')) return 'finance';
  if (value.includes('content removal')) return 'content_removal';
  if (value.includes('application') || value.includes('creator')) return 'creator_moderation';
  if (value.includes('ban') || value.includes('suspend') || value.includes('user')) return 'user_moderation';
  if (value.includes('video') || value.includes('live') || value.includes('flag')) return 'content_moderation';
  if (value.includes('setting') || value.includes('config')) return 'settings';
  if (value.includes('permission') || value.includes('role') || value.includes('admin')) return 'admin_team';
  if (value.includes('api') || value.includes('failure') || value.includes('error')) return 'api_failure';
  return 'admin_action';
}

function severityFor(action = '', status = 'success') {
  const value = String(action || '').toLowerCase();
  if (status === 'failure' || value.includes('failed') || value.includes('error')) return 'error';
  if (value.includes('delete') || value.includes('ban') || value.includes('remove')) return 'critical';
  if (value.includes('suspend') || value.includes('reject') || value.includes('deactivate')) return 'warning';
  return 'info';
}

function fallbackMessage(error) {
  return String(error?.message || '').toLowerCase();
}

export async function logAdminAction(reqOrMeta, entry = {}) {
  const hasReq = reqOrMeta?.headers || reqOrMeta?.socket;
  const req = hasReq ? reqOrMeta : null;
  const meta = hasReq ? entry : reqOrMeta || {};
  const admin = req?.admin || meta.admin || {};
  const action = String(meta.action || 'Admin action').trim();
  const targetType = String(meta.targetType || meta.target_type || 'system').trim();
  const targetId = meta.targetId ?? meta.target_id ?? '';
  const status = meta.status || 'success';
  const details = redact(meta.details || {});
  const userAgent = req?.headers?.['user-agent'] || meta.userAgent || null;

  const row = {
    id: randomUUID(),
    admin_id: admin.id || meta.adminId || null,
    admin_name: admin.name || meta.adminName || admin.email || 'Admin',
    admin_email: admin.email || meta.adminEmail || null,
    action,
    action_type: meta.actionType || actionTypeFor(action, targetType),
    target_type: targetType,
    target_id: String(targetId || ''),
    resource: meta.resource || targetType,
    details,
    status,
    severity: meta.severity || severityFor(action, status),
    ip_address: clientIp(req) || meta.ipAddress || null,
    user_agent: userAgent,
    device: meta.device || deviceFromAgent(userAgent),
    created_at: new Date().toISOString(),
  };

  try {
    if (!row.admin_email && row.admin_id) {
      try {
        const { data } = await supabase
          .from('admin_users')
          .select('name,email')
          .eq('id', row.admin_id)
          .maybeSingle();
        if (data?.email) row.admin_email = data.email;
        if ((!row.admin_name || row.admin_name === 'Admin') && data?.name) row.admin_name = data.name;
      } catch {
        /* best effort enrichment */
      }
    }
    const { error } = await supabase.from('admin_audit_logs').insert(row);
    if (error) throw error;
    auditEvents.emit('created', row);
    return { ok: true, row };
  } catch (error) {
    const msg = fallbackMessage(error);
    if (msg.includes('column') || msg.includes('schema cache') || error?.code === '42703' || error?.code === 'PGRST204') {
      const fallback = {
        id: row.id,
        admin_id: row.admin_id,
        admin_name: row.admin_name,
        action: row.action,
        target_type: row.target_type,
        target_id: row.target_id,
        details: row.details,
        status: row.status,
      };
      try {
        const { error: fallbackError } = await supabase.from('admin_audit_logs').insert(fallback);
        if (!fallbackError) {
          auditEvents.emit('created', row);
          return { ok: true, row, fallback: true };
        }
      } catch (_) {}
    }
    console.warn('[admin-audit] insert failed:', error?.message || error);
    return { ok: false, error };
  }
}

export async function logAction(adminId, adminName, action, targetType, targetId, details = {}, req = null) {
  return logAdminAction(req || {
    admin: {
      id: adminId,
      name: adminName,
    },
  }, { action, targetType, targetId, details });
}

export function subscribeAuditLogEvents(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send('connected', { ok: true, timestamp: new Date().toISOString() });
  const onCreated = (row) => send('audit-log:created', row);
  auditEvents.on('created', onCreated);
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    auditEvents.off('created', onCreated);
  });
}
