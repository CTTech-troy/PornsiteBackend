/**
 * Admin-managed membership plans — Supabase primary (membership_plans table).
 * Firebase RTDB dependency removed.
 */

import crypto from 'crypto';
import {
  supabase,
  uploadFileToBucket,
  getPublicUrl,
  IMAGE_BUCKET,
  isConfigured as isSupabaseConfigured,
} from '../config/supabase.js';

function normalizePlan(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id:          String(row.id),
    title:       String(row.name          || '').trim(),
    description: String(row.description   || '').trim(),
    price:       Number(row.price_usd)    || 0,
    currency:    String(row.currency      || 'USD').toUpperCase(),
    duration:    String(row.duration_label || `${row.duration_days || 30} Days`).trim(),
    features:    Array.isArray(row.features) ? row.features : [],
    image:       row.image_url            || null,
    isActive:    row.is_active            !== false,
    sortOrder:   Number(row.sort_order)   || 0,
    createdAt:   row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt:   row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    // Payment fields retained for callers that need them
    price_usd:     Number(row.price_usd)     || 0,
    price_ngn:     Number(row.price_ngn)     || 0,
    duration_days: Number(row.duration_days) || 30,
    coins:         Number(row.coins)         || 0,
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

export async function getPublicPlans(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [] });

    const { data, error } = await supabase
      .from('membership_plans')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;

    const plans = (data || []).map(normalizePlan).filter(Boolean);
    return res.json({ success: true, data: plans });
  } catch (err) {
    console.error('membershipPlans.getPublicPlans', err?.message || err);
    return res.status(500).json({ success: false, data: [], error: err?.message || 'Failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function getAdminPlans(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [], stats: { total: 0, active: 0, disabled: 0 } });

    const { data, error } = await supabase
      .from('membership_plans')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;

    const plans  = (data || []).map(normalizePlan).filter(Boolean);
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

export async function createPlan(req, res) {
  try {
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { title, description, price, currency, duration, features, image, isActive, sortOrder } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }
    if (price == null || isNaN(Number(price))) {
      return res.status(400).json({ success: false, error: 'price is required and must be a number' });
    }

    const id          = `plan_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const cur         = String(currency || 'USD').toUpperCase();
    const priceNum    = Number(price);
    const now         = new Date().toISOString();

    const { data, error } = await supabase
      .from('membership_plans')
      .insert([{
        id,
        name:           String(title).trim(),
        description:    String(description || '').trim(),
        price_usd:      cur === 'NGN' ? 0 : priceNum,
        price_ngn:      cur === 'NGN' ? priceNum : 0,
        coins:          0,
        duration_days:  30,
        is_active:      isActive !== false && isActive !== 'false',
        currency:       cur,
        duration_label: String(duration || '30 Days').trim(),
        features:       parseFeatures(features),
        image_url:      image || null,
        sort_order:     Number(sortOrder) || 0,
        created_at:     now,
        updated_at:     now,
      }])
      .select()
      .single();
    if (error) throw error;

    return res.status(201).json({ success: true, data: normalizePlan(data) });
  } catch (err) {
    console.error('membershipPlans.createPlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function updatePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id)       return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { data: existing } = await supabase
      .from('membership_plans')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Plan not found' });

    const body    = req.body || {};
    const updates = { updated_at: new Date().toISOString() };

    if (body.title       !== undefined) updates.name           = String(body.title).trim();
    if (body.description !== undefined) updates.description    = String(body.description || '').trim();
    if (body.features    !== undefined) updates.features       = parseFeatures(body.features);
    if (body.image       !== undefined) updates.image_url      = body.image || null;
    if (body.sortOrder   !== undefined) updates.sort_order     = Number(body.sortOrder)  || 0;
    if (body.isActive    !== undefined) updates.is_active      = body.isActive !== false && body.isActive !== 'false' && body.isActive !== 0;
    if (body.currency    !== undefined) updates.currency       = String(body.currency).toUpperCase();
    if (body.duration    !== undefined) updates.duration_label = String(body.duration).trim();
    if (body.price       !== undefined) {
      const cur = updates.currency || existing.currency || 'USD';
      updates.price_usd = cur === 'NGN' ? 0 : Number(body.price);
      updates.price_ngn = cur === 'NGN' ? Number(body.price) : 0;
    }

    const { data, error } = await supabase
      .from('membership_plans')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    return res.json({ success: true, data: normalizePlan(data) });
  } catch (err) {
    console.error('membershipPlans.updatePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function deletePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id)       return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { data: existing } = await supabase
      .from('membership_plans')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ success: false, error: 'Plan not found' });

    const { error } = await supabase.from('membership_plans').delete().eq('id', id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('membershipPlans.deletePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

export async function togglePlan(req, res) {
  try {
    const { id } = req.params;
    if (!id)       return res.status(400).json({ success: false, error: 'Invalid plan id' });
    if (!supabase) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { data: current } = await supabase
      .from('membership_plans')
      .select('id, is_active')
      .eq('id', id)
      .maybeSingle();
    if (!current) return res.status(404).json({ success: false, error: 'Plan not found' });

    const newActive = req.body?.isActive != null
      ? (req.body.isActive !== false && req.body.isActive !== 'false' && req.body.isActive !== 0)
      : !current.is_active;

    const { error } = await supabase
      .from('membership_plans')
      .update({ is_active: newActive, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    return res.json({ success: true, id, isActive: newActive });
  } catch (err) {
    console.error('membershipPlans.togglePlan', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed' });
  }
}

/**
 * Fetch a single plan by ID from Supabase.
 * Name kept for backward-compatibility with membership.controller.js and payment.route.js.
 */
export async function getFirebaseRtdbPlan(planId) {
  try {
    if (!supabase || !planId) return null;
    const { data } = await supabase
      .from('membership_plans')
      .select('*')
      .eq('id', planId)
      .maybeSingle();
    return data ? normalizePlan(data) : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/memberships/upload-image
 */
export async function uploadPlanImage(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Image file required' });
    if (!isSupabaseConfigured() || !supabase) {
      return res.status(503).json({ success: false, error: 'Storage not configured on this server' });
    }

    const extMatch   = (file.originalname || '').match(/\.(jpe?g|png|gif|webp|svg)$/i);
    const ext        = extMatch ? extMatch[0].toLowerCase() : '.jpg';
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
