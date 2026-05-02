import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { isConfigured } from '../config/supabase.js';
import {
  sendPayoutApprovedEmail,
  sendPayoutPaidEmail,
  sendPayoutRejectedEmail,
} from '../services/emailService.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(v) { return Number(v) || 0; }

function paginate(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { page: p, limit: l, offset: (p - 1) * l };
}

// PostgREST returns PGRST200 when a table is missing from its schema cache.
// Postgres itself returns 42P01. Handle both.
function isMissingTable(err) {
  if (!err) return false;
  return (
    err.code === '42P01' ||
    err.code === 'PGRST200' ||
    (typeof err.message === 'string' && err.message.includes('schema cache'))
  );
}

// PostgREST returns PGRST103 when .range() is beyond the total row count.
function isRangeError(err) {
  return err?.code === 'PGRST103';
}

// ── GET /api/admin/finance/summary ───────────────────────────────────────────

export async function getFinanceSummary(req, res) {
  try {
    const { data: memberships } = await supabase
      .from('user_memberships')
      .select('amount_paid_usd, status');
    const totalRevenue = (memberships || []).reduce((s, r) => s + fmt(r.amount_paid_usd), 0);

    const { data: gifts } = await supabase
      .from('creator_earnings')
      .select('amount_usd')
      .eq('source', 'live_gift');
    const liveGiftRevenue = (gifts || []).reduce((s, r) => s + fmt(r.amount_usd), 0);

    // Optional tables — degrade silently when they don't exist yet
    let pendingPayouts = 0;
    const { data: payouts, error: payoutsErr } = await supabase
      .from('creator_payout_requests')
      .select('amount_usd')
      .eq('status', 'pending');
    if (!isMissingTable(payoutsErr)) {
      pendingPayouts = (payouts || []).reduce((s, r) => s + fmt(r.amount_usd), 0);
    }

    let adRevenue = 0;
    const { data: ads, error: adsErr } = await supabase
      .from('ad_campaigns')
      .select('revenue_usd');
    if (!isMissingTable(adsErr)) {
      adRevenue = (ads || []).reduce((s, r) => s + fmt(r.revenue_usd), 0);
    }

    const { data: recent } = await supabase
      .from('user_memberships')
      .select('id, user_id, plan_id, amount_paid_usd, payment_provider, status, started_at')
      .order('started_at', { ascending: false })
      .limit(10);

    const recentRows = recent || [];
    const txUserIds = [...new Set(recentRows.map(t => t.user_id).filter(Boolean))];
    let txUsernameMap = {};
    if (txUserIds.length > 0) {
      const { data: txUsers } = await supabase.from('users').select('id, username').in('id', txUserIds);
      if (txUsers) txUsers.forEach(u => { txUsernameMap[u.id] = u.username; });
    }

    return res.json({
      totalRevenue,
      pendingPayouts,
      liveGiftRevenue,
      adRevenue,
      recentTransactions: recentRows.map(t => ({
        id: t.id,
        type: 'Membership',
        userId: t.user_id,
        userName: txUsernameMap[t.user_id] || null,
        planId: t.plan_id,
        amount: fmt(t.amount_paid_usd),
        method: t.payment_provider || 'Unknown',
        status: t.status || 'unknown',
        date: t.started_at,
      })),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/membership-plans ───────────────────────────────────

export async function getMembershipPlansAdmin(req, res) {
  try {
    const { data: plans, error } = await supabase
      .from('membership_plans')
      .select('*')
      .order('price_usd', { ascending: true });

    if (error) return res.status(500).json({ message: error.message });

    const enriched = await Promise.all((plans || []).map(async (plan) => {
      const { data: subs, count: activeCount } = await supabase
        .from('user_memberships')
        .select('amount_paid_usd', { count: 'exact' })
        .eq('plan_id', plan.id)
        .eq('status', 'active');

      const { count: expiredCount } = await supabase
        .from('user_memberships')
        .select('*', { count: 'exact', head: true })
        .eq('plan_id', plan.id)
        .eq('status', 'expired');

      const planRevenue = (subs || []).reduce((s, r) => s + fmt(r.amount_paid_usd), 0);

      return {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        price_usd: plan.price_usd,
        price_ngn: plan.price_ngn,
        coins: plan.coins,
        duration_days: plan.duration_days,
        is_active: plan.is_active,
        activeSubscribers: activeCount || 0,
        expiredSubscribers: expiredCount || 0,
        revenue: planRevenue,
      };
    }));

    return res.json({ plans: enriched });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/membership-plans ──────────────────────────────────

export async function createMembershipPlan(req, res) {
  try {
    const { name, description, price_usd, price_ngn, coins, duration_days } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Plan name is required.' });
    if (price_usd === undefined || price_usd === '') return res.status(400).json({ message: 'Price (USD) is required.' });
    if (!coins) return res.status(400).json({ message: 'Coins amount is required.' });
    if (!duration_days) return res.status(400).json({ message: 'Duration (days) is required.' });

    const { data, error } = await supabase
      .from('membership_plans')
      .insert({
        id: randomUUID(),          // ← explicit UUID; avoids null-id if DEFAULT is missing
        name: name.trim(),
        description: description?.trim() || null,
        price_usd: parseFloat(price_usd),
        price_ngn: parseFloat(price_ngn) || 0,
        coins: parseInt(coins, 10),
        duration_days: parseInt(duration_days, 10),
        is_active: true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json({ plan: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/finance/membership-plans/:id/toggle ────────────────────────

export async function toggleMembershipPlan(req, res) {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const { data, error } = await supabase
      .from('membership_plans')
      .update({ is_active: Boolean(is_active) })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    return res.json({ plan: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/admin/finance/membership-plans/:id ────────────────────────────

export async function deleteMembershipPlan(req, res) {
  try {
    const { id } = req.params;

    const { count } = await supabase
      .from('user_memberships')
      .select('*', { count: 'exact', head: true })
      .eq('plan_id', id)
      .eq('status', 'active');

    if (count && count > 0) {
      return res.status(409).json({ message: `Cannot delete: ${count} active subscriber(s) on this plan.` });
    }

    const { error } = await supabase
      .from('membership_plans')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'Plan deleted.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/subscribers ───────────────────────────────────────

export async function getSubscribers(req, res) {
  try {
    const { search = '', planFilter = '', statusFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // Count first to avoid range-not-satisfiable on empty tables
    let countQuery = supabase
      .from('user_memberships')
      .select('*', { count: 'exact', head: true });
    if (statusFilter) countQuery = countQuery.eq('status', statusFilter);
    if (planFilter) countQuery = countQuery.eq('plan_id', planFilter);
    const { count } = await countQuery;
    const total = count || 0;

    if (total === 0 || offset >= total) {
      return res.json({ subscribers: [], total, page, limit });
    }

    let query = supabase
      .from('user_memberships')
      .select('id, user_id, plan_id, amount_paid_usd, payment_provider, status, started_at, expires_at');
    if (statusFilter) query = query.eq('status', statusFilter);
    if (planFilter) query = query.eq('plan_id', planFilter);
    query = query.order('started_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const userIds = [...new Set((rows || []).map(r => r.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, email, username, display_name')
        .in('id', userIds);
      (users || []).forEach(u => { userMap[u.id] = u; });
    }

    const planIds = [...new Set((rows || []).map(r => r.plan_id).filter(Boolean))];
    let planMap = {};
    if (planIds.length > 0) {
      const { data: plans } = await supabase
        .from('membership_plans')
        .select('id, name')
        .in('id', planIds);
      (plans || []).forEach(p => { planMap[p.id] = p; });
    }

    const subscribers = (rows || []).map(r => {
      const u = userMap[r.user_id] || {};
      const p = planMap[r.plan_id] || {};
      return {
        id: r.id,
        userId: r.user_id,
        name: u.display_name || u.username || `User ${String(r.user_id || '').slice(0, 6)}`,
        email: u.email || '—',
        planId: r.plan_id,
        planName: p.name || r.plan_id,
        amount: fmt(r.amount_paid_usd),
        paymentMethod: r.payment_provider || '—',
        status: r.status,
        startDate: r.started_at,
        expiryDate: r.expires_at,
      };
    });

    const filtered = search
      ? subscribers.filter(s =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.email.toLowerCase().includes(search.toLowerCase()))
      : subscribers;

    return res.json({ subscribers: filtered, total, page, limit });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/payments ──────────────────────────────────────────

export async function getPaymentsAdmin(req, res) {
  try {
    const { search = '', statusFilter = '', methodFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // Stats (full table scan — no pagination needed)
    const { data: allPayments } = await supabase
      .from('user_memberships')
      .select('amount_paid_usd, status');

    const totalRevenue = (allPayments || []).reduce((s, r) => s + fmt(r.amount_paid_usd), 0);
    const pending = (allPayments || []).filter(r => r.status === 'pending').length;
    const failed = (allPayments || []).filter(r => r.status === 'failed').length;
    const refunded = (allPayments || [])
      .filter(r => r.status === 'refunded')
      .reduce((s, r) => s + fmt(r.amount_paid_usd), 0);
    const stats = { totalTransactions: allPayments?.length || 0, totalRevenue, pending, failed, refunded };

    // Count for this page's filters
    let countQuery = supabase.from('user_memberships').select('*', { count: 'exact', head: true });
    if (statusFilter) countQuery = countQuery.eq('status', statusFilter);
    if (methodFilter) countQuery = countQuery.ilike('payment_provider', `%${methodFilter}%`);
    const { count } = await countQuery;
    const total = count || 0;

    if (total === 0 || offset >= total) {
      return res.json({ payments: [], total, page, limit, stats });
    }

    let query = supabase
      .from('user_memberships')
      .select('id, user_id, plan_id, amount_paid_usd, payment_provider, payment_reference, status, started_at');
    if (statusFilter) query = query.eq('status', statusFilter);
    if (methodFilter) query = query.ilike('payment_provider', `%${methodFilter}%`);
    query = query.order('started_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    const userIds = [...new Set((rows || []).map(r => r.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, email, username, display_name')
        .in('id', userIds);
      (users || []).forEach(u => { userMap[u.id] = u; });
    }

    const planIds = [...new Set((rows || []).map(r => r.plan_id).filter(Boolean))];
    let planMap = {};
    if (planIds.length > 0) {
      const { data: plans } = await supabase
        .from('membership_plans')
        .select('id, name')
        .in('id', planIds);
      (plans || []).forEach(p => { planMap[p.id] = p; });
    }

    const payments = (rows || []).map(r => {
      const u = userMap[r.user_id] || {};
      const p = planMap[r.plan_id] || {};
      return {
        id: r.id,
        reference: r.payment_reference || `TXN-${String(r.id || '').slice(0, 8).toUpperCase()}`,
        userId: r.user_id,
        name: u.display_name || u.username || `User ${String(r.user_id || '').slice(0, 6)}`,
        email: u.email || '—',
        item: p.name || 'Membership',
        amount: fmt(r.amount_paid_usd),
        method: r.payment_provider || 'Unknown',
        status: r.status,
        date: r.started_at,
      };
    });

    const filtered = search
      ? payments.filter(p =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.email.toLowerCase().includes(search.toLowerCase()) ||
          p.reference.toLowerCase().includes(search.toLowerCase()))
      : payments;

    return res.json({ payments: filtered, total, page, limit, stats });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/payouts ────────────────────────────────────────────

const EMPTY_PAYOUT_STATS = { pendingTotal: 0, processedThisMonth: 0, totalCreatorBalances: 0, avgPayout: 0 };

export async function getCreatorPayoutsAdmin(req, res) {
  try {
    const { search = '', statusFilter = '', methodFilter = '' } = req.query;
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);

    // Count first — also validates the table exists
    let countQuery = supabase
      .from('creator_payout_requests')
      .select('*', { count: 'exact', head: true });
    if (statusFilter) countQuery = countQuery.eq('status', statusFilter);
    if (methodFilter) countQuery = countQuery.ilike('method', `%${methodFilter}%`);
    if (search) countQuery = countQuery.or(`creator_name.ilike.%${search}%,creator_email.ilike.%${search}%`);

    const { count, error: countErr } = await countQuery;

    if (isMissingTable(countErr)) {
      return res.json({ payouts: [], total: 0, page, limit, stats: EMPTY_PAYOUT_STATS });
    }
    if (countErr) return res.status(500).json({ message: countErr.message });

    const total = count || 0;

    // Earnings for stats (always available)
    const { data: earnings } = await supabase.from('creator_earnings').select('amount_usd');
    const totalCreatorBalances = (earnings || []).reduce((s, r) => s + fmt(r.amount_usd), 0);

    if (total === 0 || offset >= total) {
      return res.json({ payouts: [], total, page, limit, stats: { ...EMPTY_PAYOUT_STATS, totalCreatorBalances } });
    }

    let query = supabase.from('creator_payout_requests').select('*');
    if (statusFilter) query = query.eq('status', statusFilter);
    if (methodFilter) query = query.ilike('method', `%${methodFilter}%`);
    if (search) query = query.or(`creator_name.ilike.%${search}%,creator_email.ilike.%${search}%`);
    query = query.order('requested_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data: rows, error } = await query;
    if (error) return res.status(500).json({ message: error.message });

    // Stats
    const { data: allPayouts } = await supabase
      .from('creator_payout_requests')
      .select('amount_usd, status');

    const pendingTotal = (allPayouts || [])
      .filter(r => r.status === 'pending')
      .reduce((s, r) => s + fmt(r.amount_usd), 0);

    const completed = (allPayouts || []).filter(r => r.status === 'completed');
    const processedThisMonth = completed.reduce((s, r) => s + fmt(r.amount_usd), 0);
    const avgPayout = completed.length ? processedThisMonth / completed.length : 0;

    return res.json({
      payouts: rows || [],
      total,
      page,
      limit,
      stats: { pendingTotal, processedThisMonth, totalCreatorBalances, avgPayout },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/approve ───────────────────────────────

export async function approveCreatorPayout(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('creator_payout_requests')
      .update({ status: 'processing', processed_at: new Date().toISOString(), processed_by: req.admin?.id || null })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Payout not found or already processed.' });

    // Send approval email (non-blocking)
    const email = data.creator_email;
    if (email) {
      sendPayoutApprovedEmail({
        to:            email,
        name:          data.creator_name,
        amountUsd:     data.amount_usd,
        amountNgn:     data.amount_ngn,
        bankName:      data.bank_name,
        accountNumber: data.account_number,
        accountName:   data.account_name || data.creator_name,
        referenceId:   data.reference_id,
      }).catch(e => console.error('[finance] payout approved email:', e.message));
    }

    return res.json({ message: 'Payout approved.', payout: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/mark-paid ─────────────────────────────

export async function markPayoutPaid(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('creator_payout_requests')
      .update({ status: 'paid', processed_at: new Date().toISOString(), processed_by: req.admin?.id || null })
      .eq('id', id)
      .eq('status', 'processing')
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Payout not found or not in processing state.' });

    const email = data.creator_email;
    if (email) {
      sendPayoutPaidEmail({
        to:            email,
        name:          data.creator_name,
        amountUsd:     data.amount_usd,
        amountNgn:     data.amount_ngn,
        bankName:      data.bank_name,
        accountNumber: data.account_number,
        accountName:   data.account_name || data.creator_name,
        referenceId:   data.reference_id,
      }).catch(e => console.error('[finance] payout paid email:', e.message));
    }

    return res.json({ message: 'Payout marked as paid.', payout: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/payouts/:id/reject ────────────────────────────────

export async function rejectCreatorPayout(req, res) {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;
    const { data, error } = await supabase
      .from('creator_payout_requests')
      .update({
        status:           'rejected',
        rejection_reason: reason,
        processed_at:     new Date().toISOString(),
        processed_by:     req.admin?.id || null,
      })
      .eq('id', id)
      .in('status', ['pending', 'processing'])
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Payout not found or already completed.' });

    const email = data.creator_email;
    if (email) {
      sendPayoutRejectedEmail({
        to:       email,
        name:     data.creator_name,
        amountUsd: data.amount_usd,
        reason,
      }).catch(e => console.error('[finance] payout rejected email:', e.message));
    }

    return res.json({ message: 'Payout rejected.', payout: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/finance/ads ────────────────────────────────────────────────

const EMPTY_AD_RESPONSE = { campaigns: [], stats: { activeCampaigns: 0, totalImpressions: 0, adRevenue: 0 } };

export async function getAdCampaigns(req, res) {
  try {
    const { data: campaigns, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (isMissingTable(error)) return res.json(EMPTY_AD_RESPONSE);
    if (error) return res.status(500).json({ message: error.message });

    const active = (campaigns || []).filter(c => c.status === 'active').length;
    const totalImpressions = (campaigns || []).reduce((s, c) => s + (c.impressions || 0), 0);
    const adRevenue = (campaigns || []).reduce((s, c) => s + fmt(c.revenue_usd), 0);

    return res.json({ campaigns: campaigns || [], stats: { activeCampaigns: active, totalImpressions, adRevenue } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/ads/upload-image ──────────────────────────────────

export async function uploadAdImage(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'Image file is required.' });
    if (!isConfigured() || !supabase) {
      return res.status(503).json({ message: 'Storage not configured.' });
    }

    const bucket = process.env.SUPABASE_IMAGE_BUCKET || 'images';
    const ext = (req.file.originalname || 'ad.jpg').split('.').pop()?.toLowerCase() || 'jpg';
    const filename = `ads/${randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (error) return res.status(500).json({ message: error.message });

    const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const imageUrl = `${baseUrl}/storage/v1/object/public/${bucket}/${data.path}`;

    // Detect image dimensions if sharp is available; otherwise fall back to 0
    let width = 0;
    let height = 0;
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(req.file.buffer).metadata();
      width  = meta.width  || 0;
      height = meta.height || 0;
    } catch (_) {}

    return res.status(201).json({ url: imageUrl, width, height });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── POST /api/admin/finance/ads ───────────────────────────────────────────────

const VALID_PLACEMENTS = ['homepage_banner', 'sidebar', 'video_player', 'creator_profile', 'feed'];

export async function createAdCampaign(req, res) {
  try {
    const {
      name, description, budget_usd, cpc,
      start_date, end_date,
      image_url, redirect_url, cta_text, placement,
      image_width, image_height,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ message: 'Campaign name is required.' });
    if (redirect_url && !/^https?:\/\/.+/i.test(redirect_url.trim())) {
      return res.status(400).json({ message: 'Redirect URL must be a valid http(s) URL.' });
    }
    const resolvedPlacement = VALID_PLACEMENTS.includes(placement) ? placement : 'homepage_banner';

    const { data, error } = await supabase
      .from('ad_campaigns')
      .insert({
        id:           randomUUID(),
        name:         name.trim(),
        description:  description?.trim() || null,
        budget_usd:   parseFloat(budget_usd) || 0,
        cpc:          parseFloat(cpc) || 0,
        impressions:  0,
        clicks:       0,
        revenue_usd:  0,
        status:       'active',
        is_active:    true,
        start_date:   start_date || null,
        end_date:     end_date   || null,
        image_url:    image_url  || null,
        redirect_url: redirect_url?.trim() || null,
        cta_text:     cta_text?.trim()     || 'Learn More',
        placement:    resolvedPlacement,
        image_width:  parseInt(image_width)  || null,
        image_height: parseInt(image_height) || null,
        created_by:   req.admin?.id || null,
      })
      .select()
      .single();

    if (isMissingTable(error)) {
      return res.status(503).json({ message: 'Ad campaigns table not found. Run migration 011_ads_upgrade.sql in Supabase.' });
    }
    if (error) return res.status(500).json({ message: error.message });
    return res.status(201).json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/finance/ads/:id ────────────────────────────────────────────

export async function updateAdCampaign(req, res) {
  try {
    const { id } = req.params;
    const {
      name, description, budget_usd, cpc,
      status, is_active, start_date, end_date,
      image_url, redirect_url, cta_text, placement,
      image_width, image_height,
    } = req.body;

    if (redirect_url !== undefined && redirect_url && !/^https?:\/\/.+/i.test(redirect_url.trim())) {
      return res.status(400).json({ message: 'Redirect URL must be a valid http(s) URL.' });
    }

    const updates = {};
    if (name         !== undefined) updates.name         = String(name).trim();
    if (description  !== undefined) updates.description  = description;
    if (budget_usd   !== undefined) updates.budget_usd   = parseFloat(budget_usd);
    if (cpc          !== undefined) updates.cpc          = parseFloat(cpc);
    if (status       !== undefined) {
      updates.status    = status;
      updates.is_active = (status === 'active');
    }
    if (is_active    !== undefined) {
      updates.is_active = Boolean(is_active);
      if (!updates.status) updates.status = is_active ? 'active' : 'paused';
    }
    if (start_date   !== undefined) updates.start_date   = start_date   || null;
    if (end_date     !== undefined) updates.end_date     = end_date     || null;
    if (image_url    !== undefined) updates.image_url    = image_url    || null;
    if (redirect_url !== undefined) updates.redirect_url = redirect_url?.trim() || null;
    if (cta_text     !== undefined) updates.cta_text     = cta_text?.trim() || 'Learn More';
    if (placement    !== undefined && VALID_PLACEMENTS.includes(placement)) updates.placement = placement;
    if (image_width  !== undefined) updates.image_width  = parseInt(image_width)  || null;
    if (image_height !== undefined) updates.image_height = parseInt(image_height) || null;

    const { data, error } = await supabase
      .from('ad_campaigns')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    if (!data) return res.status(404).json({ message: 'Campaign not found.' });
    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/admin/finance/ads/:id ────────────────────────────────────────

export async function deleteAdCampaign(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });
    return res.json({ message: 'Campaign deleted.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}
