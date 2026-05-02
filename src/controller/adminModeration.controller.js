import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseDb } from '../config/firebase.js';

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
  await supabase.from('admin_audit_logs').insert({
    id: randomUUID(),
    admin_id: adminId || null,
    admin_name: adminName || 'Admin',
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    details,
    status: 'success',
  });
}

// ── GET /api/admin/moderation/reports ─────────────────────────────────────────

export async function getReports(req, res) {
  try {
    const { search = '', statusFilter = '', typeFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    const db = getFirebaseDb();
    if (!db) return res.json({ reports: [], total: 0, page, limit });

    const snap = await db.collection('contentRemovalRequests').orderBy('createdAt', 'desc').get();
    let reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (statusFilter) {
      reports = reports.filter(r => r.status === statusFilter);
    }
    if (typeFilter) {
      reports = reports.filter(r => (r.contentType || r.type) === typeFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      reports = reports.filter(r =>
        (r.fullname || '').toLowerCase().includes(q) ||
        (r.emailAddress || '').toLowerCase().includes(q) ||
        (r.title || '').toLowerCase().includes(q) ||
        (r.reason || '').toLowerCase().includes(q)
      );
    }

    const total = reports.length;
    const paginated = reports.slice(offset, offset + limit).map(r => ({
      id: r.id,
      contentType: r.contentType || r.type || 'video',
      contentTitle: r.title || r.urlToContent || 'N/A',
      reporter: r.fullname || 'Anonymous',
      reporterEmail: r.emailAddress || '',
      reason: r.reason || '',
      explanation: r.explanation || '',
      url: r.urlToContent || '',
      additionalUrls: r.additionalUrls || [],
      status: r.status || 'pending',
      date: r.createdAt || r.date || null,
      decision: r.decision || null,
      reviewNote: r.reviewNote || '',
    }));

    return res.json({ reports: paginated, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/moderation/reports/:id ─────────────────────────────────────

export async function updateReport(req, res) {
  try {
    const { id } = req.params;
    const { status, decision, reviewNote = '' } = req.body;
    const allowed = ['pending', 'under_review', 'resolved', 'dismissed', 'escalated', 'removed'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const db = getFirebaseDb();
    if (!db) return res.status(503).json({ message: 'Firebase not configured.' });

    const update = {
      updatedAt: new Date().toISOString(),
      reviewedBy: req.admin?.name || 'Admin',
    };
    if (status) update.status = status;
    if (decision) update.decision = decision;
    if (reviewNote) update.reviewNote = reviewNote;

    await db.collection('contentRemovalRequests').doc(id).update(update);

    await logAction(req.admin?.id, req.admin?.name, `Report ${status || 'updated'}`, 'report', id, { status, decision, reviewNote });
    return res.json({ message: 'Report updated successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/moderation/audit-logs ──────────────────────────────────────

export async function getAuditLogs(req, res) {
  try {
    const { search = '', actionFilter = '', adminFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    let countQ = supabase.from('admin_audit_logs').select('*', { count: 'exact', head: true });
    if (actionFilter) countQ = countQ.ilike('action', `%${actionFilter}%`);
    if (adminFilter) countQ = countQ.eq('admin_name', adminFilter);
    if (search) countQ = countQ.or(`action.ilike.%${search}%,admin_name.ilike.%${search}%,target_id.ilike.%${search}%`);

    const { count, error: countErr } = await countQ;
    if (countErr) {
      if (isMissingTable(countErr)) return res.json({ logs: [], total: 0, page, limit });
      return res.status(500).json({ message: countErr.message });
    }

    const total = count || 0;
    if (total === 0 || offset >= total) return res.json({ logs: [], total, page, limit });

    let q = supabase.from('admin_audit_logs').select('*');
    if (actionFilter) q = q.ilike('action', `%${actionFilter}%`);
    if (adminFilter) q = q.eq('admin_name', adminFilter);
    if (search) q = q.or(`action.ilike.%${search}%,admin_name.ilike.%${search}%,target_id.ilike.%${search}%`);
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
