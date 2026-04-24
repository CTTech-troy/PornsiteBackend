import { supabase, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { getNgnToUsdRate, ngnToUsd } from '../utils/exchangeRate.js';

const CREATOR_SHARE = 0.70;
const VIEW_MILESTONE = 1000;
const VIEW_MILESTONE_USD = 0.65;

function ensureSupabase() {
  if (!isSupabaseConfigured() || !supabase) throw new Error('Supabase not configured');
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
    ensureSupabase();

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

    return res.json({ success: true, totalUsd, liveUsd, viewsUsd, rows });
  } catch (err) {
    console.error('[earnings] getEarnings error:', err?.message);
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
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
