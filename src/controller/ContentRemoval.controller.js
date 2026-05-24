import crypto from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import {
  sendContentRemovalConfirmationEmail,
  sendContentRemovalFeedbackEmail,
  sendContentRemovalStatusEmail,
} from '../services/emailService.js';
import {
  emitContentRemovalEvent,
  subscribeContentRemovalEvents,
} from '../services/contentRemovalEvents.service.js';
import { logAdminAction } from '../services/adminAudit.service.js';
import { normalizeAdminMessage } from '../services/emailRenderer.js';

export { subscribeContentRemovalEvents };

const BUCKET = process.env.SUPABASE_CONTENT_REMOVAL_BUCKET || 'content_removal_evidence';
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const STATUS_VALUES = new Set(['pending', 'under_review', 'approved', 'rejected', 'needs_info']);
const STATUS_LABELS = {
  pending: 'Pending',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  needs_info: 'Needs More Information',
};

function cleanString(value, max = 2000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanLongText(value, max = 8000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function normalizeUrl(value) {
  const raw = cleanString(value, 2000);
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeUrl(item)).filter(Boolean).slice(0, 25);
  return String(value ?? '')
    .split(/\r?\n|,/)
    .map((item) => normalizeUrl(item))
    .filter(Boolean)
    .slice(0, 25);
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isMissingSchema(err) {
  return (
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    err?.code === 'PGRST204' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'))
  );
}

function requestId() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `CR-${day}-${suffix}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function findContentRemoval(identifier, columns = '*') {
  const id = cleanString(identifier, 120);
  let query = supabase.from('content_removal_requests').select(columns);
  query = isUuid(id) ? query.eq('id', id) : query.eq('request_id', id);
  return query.maybeSingle();
}

function buildActivity(type, actor, message, extra = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    actor: cleanString(actor || 'System', 160),
    message: cleanLongText(message || '', 1200),
    at: new Date().toISOString(),
    ...extra,
  };
}

function mapBodyToPayload(body = {}, existing = {}) {
  return {
    full_name: cleanString(body.full_name ?? body.fullName ?? body.fullname ?? existing.full_name, 180),
    email: normalizeEmail(body.email ?? body.emailAddress ?? body.EmailAddress ?? existing.email),
    company: cleanString(body.company ?? body.Company ?? existing.company, 180),
    phone: cleanString(body.phone ?? body.phoneNumber ?? body.PhoneNumber ?? existing.phone, 80),
    relationship_to_content: cleanString(
      body.relationship_to_content ??
        body.relationship ??
        body.relationshipToContent ??
        body.Relationship2Content ??
        existing.relationship_to_content,
      160,
    ),
    content_url: normalizeUrl(body.content_url ?? body.url ?? body.urlToContent ?? body.URL2Content ?? existing.content_url),
    additional_urls: normalizeArray(body.additional_urls ?? body.additionalUrls ?? body.AdditionalURLs ?? existing.additional_urls),
    content_title: cleanString(body.content_title ?? body.title ?? body.Title ?? existing.content_title, 280),
    reason: cleanString(body.reason ?? body.Reason ?? existing.reason, 120),
    notes: cleanLongText(body.notes ?? body.explanation ?? body.Explanation ?? existing.notes, 8000),
    evidence_notes: cleanLongText(body.evidence_notes ?? body.evidenceNotes ?? body.evidence ?? body.Evidence ?? existing.evidence_notes, 8000),
    consent_accuracy: parseBool(body.consent_accuracy ?? body.confirmAccurate ?? body.consent1 ?? body.constent1 ?? existing.consent_accuracy),
    consent_authorized: parseBool(body.consent_authorized ?? body.confirmAuthorized ?? body.consent2 ?? existing.consent_authorized),
    digital_signature: cleanString(body.digital_signature ?? body.signature ?? body.digitalSignature ?? body.DigitalSignature ?? existing.digital_signature, 180),
    admin_notes: cleanLongText(body.admin_notes ?? body.adminNotes ?? existing.admin_notes, 8000),
  };
}

function validatePayload(payload, { partial = false } = {}) {
  const required = ['full_name', 'email', 'content_url', 'reason', 'notes'];
  for (const key of required) {
    if (!partial && !payload[key]) return `${key.replace(/_/g, ' ')} is required.`;
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return 'A valid email address is required.';
  if (payload.content_url) {
    try {
      new URL(payload.content_url);
    } catch {
      return 'A valid content URL is required.';
    }
  }
  if (!partial && payload.notes.length < 20) return 'Please provide more detail about the removal reason.';
  if (!partial && !payload.consent_accuracy) return 'You must confirm that the information is accurate.';
  if (!partial && !payload.consent_authorized) return 'You must confirm you are authorized to submit this request.';
  return '';
}

function publicRequest(row) {
  if (!row) return null;
  const deadline = row.deadline_at || (row.submitted_at ? new Date(new Date(row.submitted_at).getTime() + TWO_WEEKS_MS).toISOString() : null);
  const overdue = deadline ? Date.now() > new Date(deadline).getTime() && !['approved', 'rejected'].includes(row.status) : false;
  return {
    ...row,
    request_id: row.request_id || row.id,
    status_label: STATUS_LABELS[row.status] || row.status,
    deadline_at: deadline,
    overdue,
  };
}

async function ensureEvidenceBucket() {
  if (!isConfigured() || !supabase) throw new Error('Supabase is not configured.');
  try {
    const { error } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    });
    if (error && !/already exists|duplicate/i.test(error.message || '')) {
      console.warn('[content-removal] bucket create:', error.message || error);
    }
  } catch (err) {
    if (!/already exists|duplicate/i.test(err?.message || '')) {
      console.warn('[content-removal] bucket create:', err?.message || err);
    }
  }
}

async function uploadEvidenceFiles(files = [], reqId) {
  if (!files.length) return [];
  await ensureEvidenceBucket();

  const uploaded = [];
  for (const file of files) {
    const ext = (file.originalname || '').match(/\.[a-z0-9]+$/i)?.[0] || '';
    const safeName = cleanString(file.originalname || 'evidence', 160).replace(/[^a-zA-Z0-9._-]/g, '_') || 'evidence';
    const path = `${reqId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext || `-${safeName}`}`;
    const { data, error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Evidence upload failed: ${error.message}`);
    uploaded.push({
      name: safeName,
      originalName: cleanString(file.originalname || safeName, 180),
      mimeType: file.mimetype || 'application/octet-stream',
      size: Number(file.size || 0),
      bucket: BUCKET,
      path: data.path,
      uploadedAt: new Date().toISOString(),
    });
  }
  return uploaded;
}

async function attachSignedUrls(row) {
  const request = publicRequest(row);
  const files = Array.isArray(request?.files) ? request.files : [];
  if (!files.length || !supabase) return request;

  const signedFiles = await Promise.all(files.map(async (file) => {
    if (!file?.path || !file?.bucket) return file;
    const { data } = await supabase.storage.from(file.bucket).createSignedUrl(file.path, 60 * 60);
    return { ...file, signedUrl: data?.signedUrl || null };
  }));
  return { ...request, files: signedFiles };
}

async function notifyStatus(row, status, message, adminName) {
  const request = publicRequest(row);
  if (!request?.email) return;
  sendContentRemovalStatusEmail({
    to: request.email,
    name: request.full_name,
    requestId: request.request_id,
    status,
    statusLabel: request.status_label,
    message,
    adminName,
    deadlineAt: request.deadline_at,
  }).catch((err) => console.warn('[content-removal] status email failed:', err.message || err));
}

export async function createContentRemoval(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.status(503).json({ success: false, message: 'Database service is temporarily unavailable.' });
    }

    const payload = mapBodyToPayload(req.body);
    const validationError = validatePayload(payload);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const rid = requestId();
    const now = new Date();
    const deadline = new Date(now.getTime() + TWO_WEEKS_MS).toISOString();
    const files = await uploadEvidenceFiles(req.files || [], rid);
    const activity = [
      buildActivity('submitted', payload.full_name, 'Content removal request submitted.'),
      buildActivity('email_confirmation', 'System', 'Confirmation email queued for requester.'),
    ];

    const row = {
      request_id: rid,
      ...payload,
      status: 'pending',
      files,
      activity,
      submitted_at: now.toISOString(),
      deadline_at: deadline,
      updated_at: now.toISOString(),
    };

    const { data, error } = await supabase
      .from('content_removal_requests')
      .insert(row)
      .select()
      .maybeSingle();

    if (error) {
      const message = isMissingSchema(error)
        ? 'Content removal database table is missing. Run the latest Supabase migration.'
        : error.message;
      return res.status(500).json({ success: false, message });
    }

    const request = publicRequest(data);
    sendContentRemovalConfirmationEmail({
      to: request.email,
      name: request.full_name,
      requestId: request.request_id,
      contentUrl: request.content_url,
      deadlineAt: request.deadline_at,
    }).catch((err) => console.warn('[content-removal] confirmation email failed:', err.message || err));

    emitContentRemovalEvent(req.app?.get('io'), 'content-removal:created', request);

    return res.status(201).json({
      success: true,
      message: 'Content removal request created successfully.',
      data: request,
    });
  } catch (error) {
    console.error('createContentRemoval error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create content removal request.',
    });
  }
}

export async function getAllContentRemovals(req, res) {
  try {
    if (!isConfigured() || !supabase) return res.status(503).json({ success: false, message: 'Database service is temporarily unavailable.' });

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const status = cleanString(req.query.status || '', 40);
    const search = cleanString(req.query.search || '', 300);

    let query = supabase
      .from('content_removal_requests')
      .select('*', { count: 'exact' })
      .order('submitted_at', { ascending: false })
      .range(from, to);

    if (status && status !== 'all') query = query.eq('status', status);
    if (search) {
      const q = search.replace(/[%_,().]/g, ' ');
      query = query.or(`request_id.ilike.%${q}%,email.ilike.%${q}%,content_url.ilike.%${q}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      const message = isMissingSchema(error)
        ? 'Content removal database table is missing. Run the latest Supabase migration.'
        : error.message;
      return res.status(500).json({ success: false, message });
    }

    const requests = await Promise.all((data || []).map(attachSignedUrls));
    return res.json({
      success: true,
      count: count || requests.length,
      page,
      limit,
      data: requests,
    });
  } catch (error) {
    console.error('getAllContentRemovals error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch content removal requests.' });
  }
}

export async function getContentRemovalById(req, res) {
  try {
    const id = cleanString(req.params.id, 120);
    const { data, error } = await findContentRemoval(id);

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data) return res.status(404).json({ success: false, message: 'Content removal request not found.' });

    return res.json({ success: true, data: await attachSignedUrls(data) });
  } catch (error) {
    console.error('getContentRemovalById error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch content removal request.' });
  }
}

export async function updateContentRemoval(req, res) {
  try {
    const id = cleanString(req.params.id, 120);
    const { data: existing, error: fetchError } = await findContentRemoval(id);
    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: 'Content removal request not found.' });

    const payload = mapBodyToPayload(req.body, existing);
    const validationError = validatePayload(payload, { partial: false });
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const activity = Array.isArray(existing.activity) ? existing.activity : [];
    const updated = {
      ...payload,
      activity: [
        buildActivity('edited', req.admin?.name || req.admin?.email || 'Admin', 'Request information updated by admin.'),
        ...activity,
      ].slice(0, 100),
      updated_at: new Date().toISOString(),
      updated_by: req.admin?.id || req.admin?.email || null,
    };

    const { data, error } = await supabase
      .from('content_removal_requests')
      .update(updated)
      .eq('id', existing.id)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    const request = await attachSignedUrls(data);
    await logAdminAction(req, {
      action: 'Content removal request updated',
      targetType: 'content_removal',
      targetId: request.request_id || request.id,
      details: { id: request.id, content_url: request.content_url },
    });
    emitContentRemovalEvent(req.app?.get('io'), 'content-removal:updated', request);
    return res.json({ success: true, message: 'Content removal request updated successfully.', data: request });
  } catch (error) {
    console.error('updateContentRemoval error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update content removal request.' });
  }
}

export async function updateContentRemovalStatus(req, res) {
  try {
    const id = cleanString(req.params.id, 120);
    const status = cleanString(req.body.status, 40);
    const message = normalizeAdminMessage(req.body.message || req.body.feedback || '', 4000);
    if (!STATUS_VALUES.has(status)) return res.status(400).json({ success: false, message: 'Invalid request status.' });

    const { data: existing, error: fetchError } = await findContentRemoval(id);
    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: 'Content removal request not found.' });

    const now = new Date().toISOString();
    const activity = Array.isArray(existing.activity) ? existing.activity : [];
    const patch = {
      status,
      feedback_message: message || existing.feedback_message || null,
      updated_at: now,
      updated_by: req.admin?.id || req.admin?.email || null,
      activity: [
        buildActivity('status', req.admin?.name || req.admin?.email || 'Admin', `Status changed to ${STATUS_LABELS[status] || status}.`, { status }),
        ...activity,
      ].slice(0, 100),
    };

    if (status === 'under_review' && !existing.review_started_at) patch.review_started_at = now;
    if (['approved', 'rejected'].includes(status)) patch.decision_at = now;

    const { data, error } = await supabase
      .from('content_removal_requests')
      .update(patch)
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const request = await attachSignedUrls(data);
    await notifyStatus(request, status, message, req.admin?.name || req.admin?.email || 'Admin');
    await logAdminAction(req, {
      action: `Content removal ${status}`,
      targetType: 'content_removal',
      targetId: request.request_id || request.id,
      details: { id: request.id, status, message },
    });
    emitContentRemovalEvent(req.app?.get('io'), 'content-removal:updated', request, { status });
    return res.json({ success: true, message: 'Request status updated.', data: request });
  } catch (error) {
    console.error('updateContentRemovalStatus error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update request status.' });
  }
}

export async function sendContentRemovalFeedback(req, res) {
  try {
    const id = cleanString(req.params.id, 120);
    const message = normalizeAdminMessage(req.body.message || '', 4000);
    if (!message.trim()) return res.status(400).json({ success: false, message: 'Feedback message is required.' });

    const { data: existing, error: fetchError } = await findContentRemoval(id);
    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: 'Content removal request not found.' });

    await sendContentRemovalFeedbackEmail({
      to: existing.email,
      name: existing.full_name,
      requestId: existing.request_id,
      message,
      adminName: req.admin?.name || req.admin?.email || 'Admin',
    });

    const activity = Array.isArray(existing.activity) ? existing.activity : [];
    const { data, error } = await supabase
      .from('content_removal_requests')
      .update({
        feedback_message: message,
        updated_at: new Date().toISOString(),
        updated_by: req.admin?.id || req.admin?.email || null,
        activity: [
          buildActivity('feedback', req.admin?.name || req.admin?.email || 'Admin', 'Custom feedback email sent.'),
          ...activity,
        ].slice(0, 100),
      })
      .eq('id', existing.id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });

    const request = await attachSignedUrls(data);
    await logAdminAction(req, {
      action: 'Content removal feedback sent',
      targetType: 'content_removal',
      targetId: request.request_id || request.id,
      details: { id: request.id },
    });
    emitContentRemovalEvent(req.app?.get('io'), 'content-removal:updated', request);
    return res.json({ success: true, message: 'Feedback email sent.', data: request });
  } catch (error) {
    console.error('sendContentRemovalFeedback error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send feedback.' });
  }
}

export async function deleteContentRemoval(req, res) {
  try {
    const id = cleanString(req.params.id, 120);
    const { data: existing, error: fetchError } = await findContentRemoval(id, 'id');
    if (fetchError) return res.status(500).json({ success: false, message: fetchError.message });
    if (!existing) return res.status(404).json({ success: false, message: 'Content removal request not found.' });

    const { error } = await supabase.from('content_removal_requests').delete().eq('id', existing.id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    await logAdminAction(req, {
      action: 'Content removal request deleted',
      targetType: 'content_removal',
      targetId: existing.id,
    });
    emitContentRemovalEvent(req.app?.get('io'), 'content-removal:deleted', { id: existing.id });
    return res.json({ success: true, message: 'Content removal request deleted successfully.' });
  } catch (error) {
    console.error('deleteContentRemoval error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete content removal request.' });
  }
}
