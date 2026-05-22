import { supabase } from '../config/supabase.js';
import { logAction as writeAuditAction } from '../services/adminAudit.service.js';

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await writeAuditAction(adminId, adminName, action, targetType, targetId, details);
}


// ── GET /api/admin/moderation/audit-logs ──────────────────────────────────────

export async function getAuditLogs(req, res) {
  try {
    const {
      search = '',
      actionFilter = '',
      adminFilter = '',
      severityFilter = '',
      statusFilter = '',
      fromDate = '',
      toDate = '',
    } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('admin_audit_logs').select('*', { count: 'exact', head: true });
    if (actionFilter) countQ = countQ.or(`action.ilike.%${actionFilter}%,action_type.ilike.%${actionFilter}%`);
    if (adminFilter) countQ = countQ.or(`admin_name.ilike.%${adminFilter}%,admin_email.ilike.%${adminFilter}%`);
    if (severityFilter) countQ = countQ.eq('severity', severityFilter);
    if (statusFilter) countQ = countQ.eq('status', statusFilter);
    if (fromDate) countQ = countQ.gte('created_at', new Date(String(fromDate)).toISOString());
    if (toDate) countQ = countQ.lte('created_at', new Date(String(toDate)).toISOString());
    if (search) {
      countQ = countQ.or(`action.ilike.%${search}%,action_type.ilike.%${search}%,admin_name.ilike.%${search}%,admin_email.ilike.%${search}%,target_id.ilike.%${search}%,target_type.ilike.%${search}%`);
    }

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ logs: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ logs: [], total, page, limit });

    let q = supabase.from('admin_audit_logs').select('*');
    if (actionFilter) q = q.or(`action.ilike.%${actionFilter}%,action_type.ilike.%${actionFilter}%`);
    if (adminFilter) q = q.or(`admin_name.ilike.%${adminFilter}%,admin_email.ilike.%${adminFilter}%`);
    if (severityFilter) q = q.eq('severity', severityFilter);
    if (statusFilter) q = q.eq('status', statusFilter);
    if (fromDate) q = q.gte('created_at', new Date(String(fromDate)).toISOString());
    if (toDate) q = q.lte('created_at', new Date(String(toDate)).toISOString());
    if (search) {
      q = q.or(`action.ilike.%${search}%,action_type.ilike.%${search}%,admin_name.ilike.%${search}%,admin_email.ilike.%${search}%,target_id.ilike.%${search}%,target_type.ilike.%${search}%`);
    }
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });

    return res.json({ logs: data || [], total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/moderation/ai-flags ────────────────────────────────────────

export async function getAIFlags(req, res) {
  try {
    const { search = '', statusFilter = '', severityFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('ai_flags').select('*', { count: 'exact', head: true });
    if (statusFilter) countQ = countQ.eq('status', statusFilter);
    if (severityFilter) countQ = countQ.eq('severity', severityFilter);
    if (search) countQ = countQ.or(`content_id.ilike.%${search}%,reason.ilike.%${search}%`);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ flags: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ flags: [], total, page, limit });

    let q = supabase.from('ai_flags').select('*');
    if (statusFilter) q = q.eq('status', statusFilter);
    if (severityFilter) q = q.eq('severity', severityFilter);
    if (search) q = q.or(`content_id.ilike.%${search}%,reason.ilike.%${search}%`);
    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ message: error.message });

    return res.json({ flags: data || [], total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/moderation/ai-flags/:id ────────────────────────────────────

export async function updateAIFlag(req, res) {
  try {
    const { id } = req.params;
    const { status, reviewNote = '' } = req.body;
    const allowed = ['pending', 'reviewed', 'dismissed', 'actioned'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const { error } = await supabase.from('ai_flags')
      .update({ status, review_note: reviewNote, reviewed_at: new Date().toISOString(), reviewed_by: req.admin?.name })
      .eq('id', id);

    if (error) {
      if (isMissingTable(error)) return res.status(404).json({ message: 'AI flags table not found.' });
      return res.status(500).json({ message: error.message });
    }

    await logAction(req.admin?.id, req.admin?.name, `AI flag ${status}`, 'ai_flag', id, { status, reviewNote });
    return res.json({ message: 'AI flag updated successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}
