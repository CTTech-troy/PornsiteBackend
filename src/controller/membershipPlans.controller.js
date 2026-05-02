/**
 * Admin-managed membership plans — Firebase RTDB storage.
 * Plans are stored at: membershipPlans/{id}
 *
 * Schema per plan:
 *   id          string
 *   title       string
 *   description string
 *   price       number   (display price)
 *   currency    string   ("USD" | "NGN" | …)
 *   duration    string   ("30 Days", "Monthly", "Yearly", …)
 *   features    string[] (list of bullet-point benefits)
 *   image       string | null  (URL via Supabase storage)
 *   isActive    boolean  (false = hidden from public)
 *   sortOrder   number   (ascending = first)
 *   createdAt   number   (unix ms)
 *   updatedAt   number   (unix ms)
 */

import crypto from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';
import {
  supabase,
  uploadFileToBucket,
  getPublicUrl,
  IMAGE_BUCKET,
  isConfigured as isSupabaseConfigured,
} from '../config/supabase.js';

const PLANS_NODE = 'membershipPlans';
const INVALID_PATH_RE = /[.#$[\]]/;

function plansRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref(PLANS_NODE) : null;
}

function safeId(s) {
  return typeof s === 'string' && s.length > 0 && !INVALID_PATH_RE.test(s);
}

function normalizePlan(id, raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(id),
    title: String(raw.title || '').trim(),
    description: String(raw.description || '').trim(),
    price: Number(raw.price) || 0,
    currency: String(raw.currency || 'USD').toUpperCase(),
    duration: String(raw.duration || '30 Days').trim(),
    features: Array.isArray(raw.features)
      ? raw.features.filter((f) => f && typeof f === 'string').map((f) => String(f).trim())
      : [],
    image: raw.image || null,
    isActive: raw.isActive !== false,
    sortOrder: Number(raw.sortOrder) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function parseFeatures(raw) {
  if (Array.isArray(raw)) return raw.filter((f) => f && typeof f === 'string').map((f) => String(f).trim());
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw.split('\n').map((f) => f.trim()).filter(Boolean); }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/memberships
 * Returns only active plans, sorted by sortOrder then createdAt.
 */
export async function getPublicPlans(req, res) {
  try {
    const ref = plansRef();
    if (!ref) return res.json({ success: true, data: [] });

    const snap = await ref.once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return res.json({ success: true, data: [] });

    const plans = Object.entries(val)
      .map(([id, raw]) => normalizePlan(id, raw))
      .filter((p) => p && p.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);

    return res.json({ success: true, data: plans });
  } catch (err) {
    console.error('membershipPlans.getPublicPlans', err?.message || err);
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/memberships
 * Returns all plans (active + inactive) + aggregate stats.
 */
export async function getAdminPlans(req, res) {
  try {
    const ref = plansRef();
    if (!ref) {
      return res.json({ success: true, data: [], stats: { total: 0, active: 0, disabled: 0 } });
    }

    const snap = await ref.once('value');
    const val = snap.val();
    const plans = !val
      ? []
      : Object.entries(val)
          .map(([id, raw]) => normalizePlan(id, raw))
          .filter(Boolean)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);

    const active = plans.filter((p) => p.isActive).length;
    return res.json({
      success: true,
      data: plans,
      stats: { total: plans.length, active, disabled: plans.length - active },
    });
  } catch (err) {
    console.error('membershipPlans.getAdminPlans', err?.message || err);
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

/**
 * POST /api/admin/memberships
 * Create a new membership plan.
 */
export async function createPlan(req, res) {
  try {
    const ref = plansRef();
    if (!ref) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { title, description, price, currency, duration, features, image, isActive, sortOrder } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }
    if (price == null || isNaN(Number(price))) {
      return res.status(400).json({ success: false, error: 'price is required and must be a number' });
    }

    const id = `plan_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();

    const plan = {
      id,
      title: String(title).trim(),
      description: String(description || '').trim(),
      price: Number(price),
      currency: String(currency || 'USD').toUpperCase(),
      duration: String(duration || '30 Days').trim(),
      features: parseFeatures(features),
      image: image || null,
      isActive: isActive !== false && isActive !== 'false',
      sortOrder: Number(sortOrder) || 0,
      createdAt: now,
      updatedAt: now,
    };

    await ref.child(id).set(plan);
    return res.status(201).json({ success: true, data: plan });
  } catch (err) {
    console.error('membershipPlans.createPlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

/**
 * PUT /api/admin/memberships/:id
 * Replace or partially update a plan.
 */
export async function updatePlan(req, res) {
  try {
    const { id } = req.params;
    if (!safeId(id)) return res.status(400).json({ success: false, error: 'Invalid plan id' });

    const ref = plansRef();
    if (!ref) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const snap = await ref.child(id).once('value');
    if (!snap.val()) return res.status(404).json({ success: false, error: 'Plan not found' });

    const updates = { updatedAt: Date.now() };
    const allowed = ['title', 'description', 'price', 'currency', 'duration', 'features', 'image', 'isActive', 'sortOrder'];

    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, key)) continue;
      const val = req.body[key];
      if (key === 'features') {
        updates.features = parseFeatures(val);
      } else if (key === 'title') {
        updates.title = String(val).trim();
      } else if (key === 'price') {
        updates.price = Number(val) || 0;
      } else if (key === 'sortOrder') {
        updates.sortOrder = Number(val) || 0;
      } else if (key === 'isActive') {
        updates.isActive = val !== false && val !== 'false' && val !== 0;
      } else {
        updates[key] = val;
      }
    }

    await ref.child(id).update(updates);
    const updated = (await ref.child(id).once('value')).val();
    return res.json({ success: true, data: normalizePlan(id, updated) });
  } catch (err) {
    console.error('membershipPlans.updatePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

/**
 * DELETE /api/admin/memberships/:id
 */
export async function deletePlan(req, res) {
  try {
    const { id } = req.params;
    if (!safeId(id)) return res.status(400).json({ success: false, error: 'Invalid plan id' });

    const ref = plansRef();
    if (!ref) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const snap = await ref.child(id).once('value');
    if (!snap.val()) return res.status(404).json({ success: false, error: 'Plan not found' });

    await ref.child(id).remove();
    return res.json({ success: true });
  } catch (err) {
    console.error('membershipPlans.deletePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

/**
 * PATCH /api/admin/memberships/:id/toggle
 * Toggle or explicitly set isActive. Body: { isActive?: boolean }
 */
export async function togglePlan(req, res) {
  try {
    const { id } = req.params;
    if (!safeId(id)) return res.status(400).json({ success: false, error: 'Invalid plan id' });

    const ref = plansRef();
    if (!ref) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const snap = await ref.child(id).once('value');
    const current = snap.val();
    if (!current) return res.status(404).json({ success: false, error: 'Plan not found' });

    const newActive = req.body?.isActive != null
      ? (req.body.isActive !== false && req.body.isActive !== 'false' && req.body.isActive !== 0)
      : !current.isActive;

    await ref.child(id).update({ isActive: newActive, updatedAt: Date.now() });
    return res.json({ success: true, id, isActive: newActive });
  } catch (err) {
    console.error('membershipPlans.togglePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

/**
 * Fetch a single raw plan from Firebase RTDB by ID.
 * Returns null if RTDB is unavailable, the plan doesn't exist, or it is inactive.
 * Returns the normalised plan object on success.
 */
export async function getFirebaseRtdbPlan(planId) {
  try {
    const ref = plansRef();
    if (!ref) return null;
    const snap = await ref.child(planId).once('value');
    return normalizePlan(planId, snap.val());
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/memberships/upload-image
 * Upload plan image to Supabase Storage. Returns { success, url }.
 */
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
