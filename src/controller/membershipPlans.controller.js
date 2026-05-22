import crypto from 'crypto';
import {
  supabase,
  uploadFileToBucket,
  getPublicUrl,
  IMAGE_BUCKET,
  isConfigured as isSupabaseConfigured,
} from '../config/supabase.js';
import {
  getMembershipPlan,
  getMembershipPlans,
  normalizeMembershipPlan,
  planPayloadFromAdmin,
} from '../services/membershipLifecycle.service.js';

function missingColumnName(error) {
  const msg = String(error?.message || '');
  if (!(error?.code === '42703' || /column .* does not exist|schema cache|Could not find .* column/i.test(msg))) {
    return '';
  }
  return (
    msg.match(/membership_plans\.([a-zA-Z0-9_]+)/)?.[1] ||
    msg.match(/column ["']?([a-zA-Z0-9_]+)["']? does not exist/i)?.[1] ||
    msg.match(/'([a-zA-Z0-9_]+)' column/i)?.[1] ||
    ''
  );
}

function parseFeatures(raw) {
  if (Array.isArray(raw)) return raw.map((f) => String(f).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((f) => String(f).trim()).filter(Boolean);
    } catch {}
    return raw.split('\n').map((f) => f.trim()).filter(Boolean);
  }
  return [];
}

async function insertWithFallback(row) {
  let payload = { ...row };
  for (let i = 0; i < 16; i += 1) {
    const { data, error } = await supabase.from('membership_plans').insert(payload).select().maybeSingle();
    if (!error) return data;
    const missing = missingColumnName(error);
    if (!missing || !(missing in payload)) throw error;
    delete payload[missing];
  }
  throw new Error('Could not create membership plan with current database schema');
}

async function updateWithFallback(id, row) {
  let payload = { ...row };
  for (let i = 0; i < 16; i += 1) {
    const { data, error } = await supabase.from('membership_plans').update(payload).eq('id', id).select().maybeSingle();
    if (!error) return data;
    const missing = missingColumnName(error);
    if (!missing || !(missing in payload)) throw error;
    delete payload[missing];
  }
  throw new Error('Could not update membership plan with current database schema');
}

export async function getPublicPlans(_req, res) {
  try {
    const plans = await getMembershipPlans({ includeInactive: false, includeArchived: false });
    return res.json({ success: true, data: plans });
  } catch (err) {
    console.error('membershipPlans.getPublicPlans', err?.message || err);
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

export async function getAdminPlans(_req, res) {
  try {
    const plans = await getMembershipPlans({ includeInactive: true, includeArchived: false });
    const active = plans.filter((p) => p.isActive).length;
    return res.json({
      success: true,
      data: plans,
      stats: {
        total: plans.length,
        active,
        disabled: plans.length - active,
        recurring: plans.filter((p) => p.isRecurring).length,
      },
    });
  } catch (err) {
    console.error('membershipPlans.getAdminPlans', err?.message || err);
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

export async function createPlan(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });
    const body = { ...(req.body || {}), features: parseFeatures(req.body?.features) };
    const title = String(body.title || body.name || '').trim();
    if (!title) return res.status(400).json({ success: false, error: 'title is required' });
    if (body.price == null || Number.isNaN(Number(body.price))) {
      return res.status(400).json({ success: false, error: 'price is required and must be a number' });
    }

    const id = String(body.id || `plan_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    const now = new Date().toISOString();
    const row = {
      id,
      ...planPayloadFromAdmin({ ...body, title }),
      created_at: now,
      updated_at: now,
    };
    const data = await insertWithFallback(row);
    return res.status(201).json({ success: true, data: normalizeMembershipPlan(data) });
  } catch (err) {
    console.error('membershipPlans.createPlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function updatePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { data: existing, error: readError } = await supabase.from('membership_plans').select('*').eq('id', id).maybeSingle();
    if (readError) throw readError;
    if (!existing) return res.status(404).json({ success: false, error: 'Plan not found' });

    const body = { ...(req.body || {}) };
    if (body.features !== undefined) body.features = parseFeatures(body.features);
    const row = planPayloadFromAdmin(body, { existing });
    const data = await updateWithFallback(id, row);
    return res.json({ success: true, data: normalizeMembershipPlan(data) });
  } catch (err) {
    console.error('membershipPlans.updatePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function deletePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });
    const data = await updateWithFallback(id, {
      is_active: false,
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (!data) return res.status(404).json({ success: false, error: 'Plan not found' });
    return res.json({ success: true, data: normalizeMembershipPlan(data) });
  } catch (err) {
    console.error('membershipPlans.deletePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function togglePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });
    const current = await getMembershipPlan(id, { includeInactive: true });
    if (!current) return res.status(404).json({ success: false, error: 'Plan not found' });
    const newActive = req.body?.isActive != null
      ? req.body.isActive !== false && req.body.isActive !== 'false' && req.body.isActive !== 0
      : !current.isActive;
    const data = await updateWithFallback(id, {
      is_active: newActive,
      archived_at: newActive ? null : current.archivedAt,
      updated_at: new Date().toISOString(),
    });
    return res.json({ success: true, id, isActive: newActive, data: normalizeMembershipPlan(data) });
  } catch (err) {
    console.error('membershipPlans.togglePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function getFirebaseRtdbPlan(planId) {
  return getMembershipPlan(planId, { includeInactive: true }).catch(() => null);
}

export async function uploadPlanImage(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Image file required' });
    if (!isSupabaseConfigured() || !supabase) {
      return res.status(503).json({ success: false, error: 'Storage not configured on this server' });
    }

    const extMatch = (file.originalname || '').match(/\.(jpe?g|png|gif|webp|svg)$/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';
    const storagePath = `membership-plans/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;

    const uploaded = await uploadFileToBucket(IMAGE_BUCKET, storagePath, file, file.mimetype || 'image/jpeg');
    const url =
      getPublicUrl(IMAGE_BUCKET, uploaded.path) ||
      `${process.env.SUPABASE_URL?.replace(/\/$/, '')}/storage/v1/object/public/${IMAGE_BUCKET}/${uploaded.path}`;

    return res.json({ success: true, url });
  } catch (err) {
    console.error('membershipPlans.uploadPlanImage', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Upload failed' });
  }
}
