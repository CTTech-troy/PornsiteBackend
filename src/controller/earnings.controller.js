import {
  supabase,
  isConfigured as isSupabaseConfigured,
  isSupabaseAvailable,
  isSupabaseNetworkError,
  markSupabaseUnavailable,
} from '../config/supabase.js';
import { getNgnToUsdRate, ngnToUsd } from '../utils/exchangeRate.js';
import { getCreatorPayoutBalances } from '../services/payoutWorkflow.service.js';

const CREATOR_SHARE = 0.70;
const VIEW_MILESTONE = 1000;
const VIEW_MILESTONE_USD = 0.65;

function ensureSupabase() {
  if (!isSupabaseConfigured() || !isSupabaseAvailable() || !supabase) throw new Error('Supabase not configured');
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function emptyEarningsResponse(degraded = false) {
  return {
    success: true,
    totalUsd: 0,
    availableUsd: 0,
    pendingUsd: 0,
    processingUsd: 0,
    withdrawnUsd: 0,
    liveUsd: 0,
    viewsUsd: 0,
    rows: [],
    degraded,
  };
}

async function insertEarning(creatorId, amountUsd, source, sourceId) {
  try {
    ensureSupabase();
    await supabase.from('creator_earnings').insert({
      creator_id: creatorId,
      amount_usd: amountUsd,
      source,
      source_id: sourceId,
    });
  } catch (err) {
    console.warn('[earnings] insert failed:', err?.message);
  }
}

/**
 * Called after a live session ends.
 * totalGiftsNgn is the sum of all gifts received during the live (in NGN).
 * Creator receives 70%, platform retains 30%.
 */
export async function creditLiveEarnings(creatorId, totalGiftsNgn, liveId) {
  if (!creatorId || !(totalGiftsNgn > 0)) return;
  try {
    const rate = await getNgnToUsdRate();
    const totalUsd = ngnToUsd(totalGiftsNgn, rate);
    const creatorUsd = parseFloat((totalUsd * CREATOR_SHARE).toFixed(6));
    await insertEarning(creatorId, creatorUsd, 'live_gifts', liveId);
    console.log(`[earnings] Live ${liveId}: ₦${totalGiftsNgn} → $${creatorUsd} credited to ${creatorId} (rate: ${rate})`);
    return creatorUsd;
  } catch (err) {
    console.error('[earnings] creditLiveEarnings error:', err?.message);
  }
}

/**
 * Called when a video crosses the 1000-view milestone.
 * Adds $0.65 to the creator's earnings.
 */
export async function creditViewMilestone(creatorId, videoId) {
  if (!creatorId || !videoId) return;
  try {
    // Guard: only credit once per video milestone
    ensureSupabase();
    const { data: existing } = await supabase
      .from('creator_earnings')
      .select('id')
      .eq('source', 'video_views')
      .eq('source_id', videoId)
      .maybeSingle();
    if (existing) return; // already credited
    await insertEarning(creatorId, VIEW_MILESTONE_USD, 'video_views', videoId);
    console.log(`[earnings] Video ${videoId}: 1000-view milestone → $${VIEW_MILESTONE_USD} credited to ${creatorId}`);
    return VIEW_MILESTONE_USD;
  } catch (err) {
    console.error('[earnings] creditViewMilestone error:', err?.message);
  }
}

/**
 * GET /api/earnings  — returns total earnings for the authenticated creator.
 */
export async function getEarnings(req, res) {
  try {
    const uid = req.uid;
    if (!uid) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!isSupabaseConfigured() || !isSupabaseAvailable() || !supabase) {
      return res.json(emptyEarningsResponse(true));
    }

    const { data, error } = await supabase
      .from('creator_earnings')
      .select('amount_usd, source, created_at')
      .eq('creator_id', uid)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = data || [];
    const totalUsd = rows.reduce((sum, r) => sum + (Number(r.amount_usd) || 0), 0);
    const liveUsd  = rows.filter(r => r.source === 'live_gifts').reduce((s, r) => s + (Number(r.amount_usd) || 0), 0);
    const viewsUsd = rows.filter(r => r.source === 'video_views').reduce((s, r) => s + (Number(r.amount_usd) || 0), 0);

    let balances = {
      total: roundMoney(totalUsd),
      available: roundMoney(totalUsd),
      pending: 0,
      processing: 0,
      withdrawn: 0,
    };

    try {
      // Withdrawals live in creator_payout_requests, not creator_earnings.
      // Use payout-aware balances so profile cards drop immediately after a
      // creator requests or completes a withdrawal.
      balances = await getCreatorPayoutBalances(uid);
    } catch (balanceErr) {
      console.warn('[earnings] payout balance fallback:', balanceErr?.message || balanceErr);
    }

    return res.json({
      success: true,
      totalUsd: roundMoney(balances.total ?? totalUsd),
      availableUsd: roundMoney(balances.available ?? totalUsd),
      pendingUsd: roundMoney(balances.pending ?? 0),
      processingUsd: roundMoney(balances.processing ?? 0),
      withdrawnUsd: roundMoney(balances.withdrawn ?? 0),
      liveUsd: roundMoney(liveUsd),
      viewsUsd: roundMoney(viewsUsd),
      rows,
    });
  } catch (err) {
    const msg = err?.message || '';
    console.error('[earnings] getEarnings error:', msg);
    const isNetworkErr = markSupabaseUnavailable(err, 'creator earnings') || isSupabaseNetworkError(err);
    if (isNetworkErr) return res.json(emptyEarningsResponse(true));
    return res.status(500).json({
      success: false,
      message: msg || 'Failed',
    });
  }
}

/**
 * POST /api/earnings/rate  — admin updates the NGN/USD exchange rate.
 */
export async function updateExchangeRate(req, res) {
  try {
    const adminSecret = req.headers['x-admin-secret'] || req.body?.adminSecret;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const rate = parseFloat(req.body?.rate);
    if (!rate || rate <= 0) return res.status(400).json({ success: false, message: 'Invalid rate' });

    ensureSupabase();
    const { error } = await supabase
      .from('platform_settings')
      .upsert({ key: 'ngn_to_usd_rate', value: String(rate) }, { onConflict: 'key' });

    if (error) throw error;
    return res.json({ success: true, rate });
  } catch (err) {
    console.error('[earnings] updateExchangeRate error:', err?.message);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
