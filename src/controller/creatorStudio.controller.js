import { randomUUID } from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';
import {
  supabase,
  isConfigured,
  isSupabaseAvailable,
  isSupabaseNetworkError,
  markSupabaseUnavailable,
} from '../config/supabase.js';
import { getNgnToUsdRate } from '../utils/exchangeRate.js';
import {
  sendPayoutRequestedEmail,
} from '../services/emailService.js';
import {
  emitFinancePayoutEvent,
  writeFinancePayoutLog,
} from '../services/financePayoutEvents.service.js';
import { getBooleanSetting, getNumberSetting } from '../services/platformSettings.service.js';
import {
  createCreatorWithdrawalRequest,
  getCreatorPayoutBalances,
} from '../services/payoutWorkflow.service.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

function isMissingColumn(err) {
  return err?.code === '42703';
}

function emptyStudioEarnings() {
  return { total: 0, available: 0, pending: 0, bySource: [], rows: [] };
}

function studioSupabaseReady() {
  return isConfigured() && isSupabaseAvailable() && supabase;
}

async function safeStudioQuery(label, query, fallback) {
  if (!studioSupabaseReady()) return fallback;
  try {
    const result = await (typeof query === 'function' ? query() : query);
    if (result?.error && (markSupabaseUnavailable(result.error, label) || isSupabaseNetworkError(result.error))) {
      return fallback;
    }
    return result;
  } catch (err) {
    if (markSupabaseUnavailable(err, label) || isSupabaseNetworkError(err)) return fallback;
    throw err;
  }
}

// ── Level definitions ─────────────────────────────────────────────────────────
const CREATOR_LEVELS = [
  {
    id: 'beginner', name: 'Beginner Creator', icon: '🌱', color: '#94a3b8',
    minFollowers: 0, minViews: 0, premiumLimit: 5,
    perks: ['Basic analytics', 'Up to 5 premium videos'],
  },
  {
    id: 'rising', name: 'Rising Creator', icon: '⭐', color: '#f59e0b',
    minFollowers: 100, minViews: 500, premiumLimit: 20,
    perks: ['Advanced analytics', 'Up to 20 premium videos', 'Trending boost'],
  },
  {
    id: 'verified', name: 'Verified Creator', icon: '💎', color: '#6366f1',
    minFollowers: 1000, minViews: 10000, premiumLimit: 100,
    perks: ['Full analytics suite', 'Up to 100 premium uploads', 'Homepage promotion', 'Verified badge'],
  },
  {
    id: 'elite', name: 'Elite Creator', icon: '👑', color: '#10b981',
    minFollowers: 10000, minViews: 100000, premiumLimit: -1,
    perks: ['Priority support', 'Custom profile', 'Elite badge', 'Max revenue share'],
  },
];

export { CREATOR_LEVELS };

// ── Nigerian bank list (hardcoded fallback) ───────────────────────────────────
const NIGERIAN_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'Citibank Nigeria', code: '023' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'First City Monument Bank (FCMB)', code: '214' },
  { name: 'Globus Bank', code: '00103' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Heritage Bank', code: '030' },
  { name: 'Keystone Bank', code: '082' },
  { name: 'Parallex Bank', code: '104' },
  { name: 'Polaris Bank', code: '076' },
  { name: 'Providus Bank', code: '101' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Standard Chartered Bank', code: '068' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'SunTrust Bank', code: '100' },
  { name: 'Titan Trust Bank', code: '102' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'United Bank for Africa (UBA)', code: '033' },
  { name: 'Unity Bank', code: '215' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
  // Fintechs / Microfinance
  { name: 'Carbon (OneFi)', code: '565' },
  { name: 'Kuda Bank', code: '090267' },
  { name: 'Moniepoint MFB', code: '50515' },
  { name: 'OPay Digital Services', code: '999992' },
  { name: 'PalmPay', code: '999991' },
  { name: 'PayCom (Opay)', code: '305' },
  { name: 'VFD Microfinance Bank', code: '566' },
  { name: 'Rubies MFB', code: '125' },
  { name: 'ALAT by Wema', code: '035A' },
  { name: 'Raven Bank', code: '50767' },
  { name: 'Sparkle Bank', code: '090325' },
  { name: 'Cleva', code: '50823' },
];

// ── GET /api/studio/banks ─────────────────────────────────────────────────────

export async function getBanks(req, res) {
  // Try Paystack first; fall back to hardcoded list
  try {
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (paystackKey) {
      const r = await fetch('https://api.paystack.co/bank?currency=NGN&perPage=100', {
        headers: { Authorization: `Bearer ${paystackKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const json = await r.json();
        if (json.status && Array.isArray(json.data)) {
          const banks = json.data.map(b => ({ name: b.name, code: b.code }));
          return res.json({ banks });
        }
      }
    }
  } catch (_) { /* fall through to hardcoded */ }
  return res.json({ banks: NIGERIAN_BANKS });
}

// ── POST /api/studio/banks/verify ─────────────────────────────────────────────

export async function verifyBankAccount(req, res) {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'accountNumber and bankCode are required' });
    }
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackKey) {
      return res.status(503).json({ success: false, message: 'Bank verification unavailable — no Paystack key configured.' });
    }
    const r = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${paystackKey}` }, signal: AbortSignal.timeout(8000) },
    );
    const json = await r.json();
    if (!r.ok || !json.status) {
      return res.status(400).json({ success: false, message: json.message || 'Account verification failed.' });
    }
    return res.json({ success: true, accountName: json.data.account_name });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function computeLevel(followers, totalViews) {
  let level = CREATOR_LEVELS[0];
  for (const l of CREATOR_LEVELS) {
    if (followers >= l.minFollowers && totalViews >= l.minViews) level = l;
  }
  return level;
}

function videosRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('videos') : null;
}

async function getCreatorVideos(uid) {
  try {
    const ref = videosRef();
    if (!ref) return [];
    const snap = await ref.once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') return [];
    return Object.entries(val)
      .map(([videoId, v]) => (typeof v === 'object' && v ? { videoId, ...v } : null))
      .filter(v => v && v.userId === uid);
  } catch {
    return [];
  }
}

function groupEarningsByDay(rows, days) {
  const map = {};
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    map[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of rows) {
    const key = String(row.created_at || '').slice(0, 10);
    if (key in map) map[key] += Number(row.amount_usd) || 0;
  }
  return Object.entries(map).map(([date, value]) => ({
    date,
    value: parseFloat(value.toFixed(4)),
    label: date.slice(5), // MM-DD
  }));
}

// ── GET /api/studio/overview ─────────────────────────────────────────────────

export async function getOverview(req, res) {
  try {
    const uid = req.uid;

    const [videos, userRes, earningsRes] = await Promise.all([
      getCreatorVideos(uid),
      safeStudioQuery(
        'studio overview user profile',
        () => supabase.from('users').select('followers, following, coin_balance').eq('id', uid).maybeSingle(),
        { data: null }
      ),
      safeStudioQuery(
        'studio overview earnings',
        () => supabase.from('creator_earnings').select('amount_usd, source, created_at').eq('creator_id', uid),
        { data: [] }
      ),
    ]);

    const user     = userRes?.data || {};
    const earnings = earningsRes?.data || [];
    const followers = Number(user.followers) || 0;

    const totalViews  = videos.reduce((s, v) => s + (Number(v.totalViews ?? v.views) || 0), 0);
    const totalLikes  = videos.reduce((s, v) => s + (Number(v.totalLikes) || 0), 0);
    const totalUsd    = earnings.reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const premiumVids = videos.filter(v => v.isPremiumContent);

    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const monthlyEarnings = earnings
      .filter(e => new Date(e.created_at) >= thirtyAgo)
      .reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);

    let payoutBalances = {
      available: parseFloat(totalUsd.toFixed(2)),
      pending: 0,
      processing: 0,
      withdrawn: 0,
    };
    try {
      payoutBalances = await getCreatorPayoutBalances(uid);
    } catch (balanceErr) {
      console.warn('[studio] overview payout balance fallback:', balanceErr?.message || balanceErr);
    }

    const level    = computeLevel(followers, totalViews);
    const lvlIdx   = CREATOR_LEVELS.indexOf(level);
    const nextLevel = lvlIdx < CREATOR_LEVELS.length - 1 ? CREATOR_LEVELS[lvlIdx + 1] : null;

    const recentVideos = [...videos]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 6)
      .map(v => ({
        id:         v.videoId,
        title:      v.title || 'Untitled',
        views:      Number(v.totalViews ?? v.views) || 0,
        likes:      Number(v.totalLikes) || 0,
        thumbnail:  v.thumbnailUrl || v.thumbnail || null,
        isPremium:  Boolean(v.isPremiumContent),
        tokenPrice: Number(v.tokenPrice) || 0,
        createdAt:  v.createdAt,
      }));

    return res.json({
      success: true,
      data: {
        followers,
        following:       Number(user.following) || 0,
        totalViews,
        totalLikes,
        totalUploads:    videos.length,
        premiumUploads:  premiumVids.length,
        totalEarnings:   parseFloat(totalUsd.toFixed(2)),
        availableEarnings: parseFloat(Number(payoutBalances.available || 0).toFixed(2)),
        pendingEarnings: parseFloat(Number(payoutBalances.pending || 0).toFixed(2)),
        processingEarnings: parseFloat(Number(payoutBalances.processing || 0).toFixed(2)),
        withdrawnEarnings: parseFloat(Number(payoutBalances.withdrawn || 0).toFixed(2)),
        monthlyEarnings: parseFloat(monthlyEarnings.toFixed(2)),
        engagementRate:  totalViews > 0 ? Number(((totalLikes / totalViews) * 100).toFixed(1)) : 0,
        coinBalance:     Number(user.coin_balance) || 0,
        level,
        nextLevel,
        recentVideos,
      },
    });
  } catch (err) {
    console.error('[studio] getOverview:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/analytics?period=7d|30d|90d|1y ──────────────────────────

export async function getAnalytics(req, res) {
  try {
    const uid    = req.uid;
    const period = ['7d', '30d', '90d', '1y'].includes(req.query.period) ? req.query.period : '30d';
    const days   = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period];
    const since  = new Date();
    since.setDate(since.getDate() - days);

    const [videos, userRes, earningsRes] = await Promise.all([
      getCreatorVideos(uid),
      safeStudioQuery(
        'studio analytics user profile',
        () => supabase.from('users').select('followers').eq('id', uid).maybeSingle(),
        { data: null }
      ),
      safeStudioQuery(
        'studio analytics earnings',
        () => supabase.from('creator_earnings').select('amount_usd, source, created_at').eq('creator_id', uid).gte('created_at', since.toISOString()).order('created_at', { ascending: true }),
        { data: [] }
      ),
    ]);

    const earningsRows = earningsRes?.data || [];
    const followers    = Number(userRes?.data?.followers) || 0;
    const totalViews   = videos.reduce((s, v) => s + (Number(v.totalViews ?? v.views) || 0), 0);
    const totalLikes   = videos.reduce((s, v) => s + (Number(v.totalLikes) || 0), 0);

    const earningsTrend  = groupEarningsByDay(earningsRows, days);

    const sourceMap = {};
    for (const e of earningsRows) {
      const src = (e.source || 'other').replace(/_/g, ' ');
      sourceMap[src] = (sourceMap[src] || 0) + (Number(e.amount_usd) || 0);
    }
    const earningsBySource = Object.entries(sourceMap).map(([name, value]) => ({
      name:  name.charAt(0).toUpperCase() + name.slice(1),
      value: parseFloat(value.toFixed(2)),
    }));

    const topVideos = [...videos]
      .sort((a, b) => (Number(b.totalViews ?? b.views) || 0) - (Number(a.totalViews ?? a.views) || 0))
      .slice(0, 8)
      .map(v => ({
        id:    v.videoId,
        title: v.title ? v.title.slice(0, 30) : 'Untitled',
        views: Number(v.totalViews ?? v.views) || 0,
        likes: Number(v.totalLikes) || 0,
      }));

    const periodEarnings = earningsRows.reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const level   = computeLevel(followers, totalViews);
    const lvlIdx  = CREATOR_LEVELS.indexOf(level);
    const nextLvl = lvlIdx < CREATOR_LEVELS.length - 1 ? CREATOR_LEVELS[lvlIdx + 1] : null;

    return res.json({
      success: true,
      data: {
        earningsTrend,
        earningsBySource,
        topVideos,
        summary: {
          followers,
          totalViews,
          totalLikes,
          periodEarnings: parseFloat(periodEarnings.toFixed(2)),
          engagementRate: totalViews > 0 ? Number(((totalLikes / totalViews) * 100).toFixed(1)) : 0,
        },
        level,
        nextLevel: nextLvl,
      },
    });
  } catch (err) {
    console.error('[studio] getAnalytics:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/videos ───────────────────────────────────────────────────

export async function getVideos(req, res) {
  try {
    const uid    = req.uid;
    const videos = await getCreatorVideos(uid);

    const mapped = [...videos]
      .sort((a, b) => (Number(b.totalViews ?? b.views) || 0) - (Number(a.totalViews ?? a.views) || 0))
      .map(v => ({
        id:             v.videoId,
        title:          v.title || 'Untitled',
        views:          Number(v.totalViews ?? v.views) || 0,
        likes:          Number(v.totalLikes) || 0,
        comments:       Number(v.totalComments) || 0,
        thumbnail:      v.thumbnailUrl || v.thumbnail || null,
        isPremium:      Boolean(v.isPremiumContent),
        tokenPrice:     Number(v.tokenPrice) || 0,
        isPublished:    v.isLive !== false,
        createdAt:      v.createdAt,
        engagementRate: Number(v.totalViews ?? v.views) > 0
          ? Number(((Number(v.totalLikes) / Number(v.totalViews ?? v.views)) * 100).toFixed(1))
          : 0,
      }));

    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error('[studio] getVideos:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/earnings ─────────────────────────────────────────────────

export async function getEarnings(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.json({ success: true, data: emptyStudioEarnings(), degraded: true });

    const [earningsRes, pendingRes] = await Promise.all([
      safeStudioQuery(
        'studio earnings rows',
        supabase.from('creator_earnings').select('*').eq('creator_id', uid).order('created_at', { ascending: false }),
        { data: [], error: null, degraded: true }
      ),
      safeStudioQuery(
        'studio earnings pending payouts',
        supabase.from('creator_payout_requests').select('amount_usd, status').eq('creator_id', uid).in('status', ['pending', 'approved', 'processing', 'paid', 'completed']),
        { data: [], error: null, degraded: true }
      ),
    ]);

    if (earningsRes.error) {
      if (isMissingTable(earningsRes.error)) {
        return res.json({ success: true, data: emptyStudioEarnings() });
      }
      throw earningsRes.error;
    }

    const earnings = earningsRes?.data || [];
    const pending  = pendingRes?.error && (isMissingTable(pendingRes.error) || isMissingColumn(pendingRes.error))
      ? []
      : (pendingRes?.data || []);

    const total          = earnings.reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const pendingAmount  = pending.filter(w => w.status === 'pending').reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);
    const processingAmount = pending.filter(w => ['approved', 'processing'].includes(w.status)).reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);
    const withdrawnAmount = pending.filter(w => ['paid', 'completed'].includes(w.status)).reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);
    let balances = {
      total,
      available: Math.max(0, total - pendingAmount - processingAmount - withdrawnAmount),
      pending: pendingAmount,
      processing: processingAmount,
      withdrawn: withdrawnAmount,
    };
    try {
      balances = await getCreatorPayoutBalances(uid);
    } catch (_) {}
    const available = balances.available;

    const grouped = {};
    for (const e of earnings) {
      const src = e.source || 'other';
      grouped[src] = (grouped[src] || 0) + (Number(e.amount_usd) || 0);
    }

    let ngnRate = 1600;
    try { ngnRate = await getNgnToUsdRate(); } catch (_) {}

    return res.json({
      success: true,
      data: {
        total:    parseFloat(Number(balances.total || total).toFixed(2)),
        available: parseFloat(available.toFixed(2)),
        pending:  parseFloat(Number(balances.pending || 0).toFixed(2)),
        processing: parseFloat(Number(balances.processing || 0).toFixed(2)),
        withdrawn: parseFloat(Number(balances.withdrawn || 0).toFixed(2)),
        ngnRate,
        bySource: Object.entries(grouped).map(([source, amount]) => ({
          source,
          amount: parseFloat(amount.toFixed(2)),
        })),
        rows: earnings.slice(0, 30),
      },
    });
  } catch (err) {
    console.error('[studio] getEarnings:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/withdrawals ──────────────────────────────────────────────

export async function getWithdrawals(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.json({ success: true, data: [], degraded: true });

    const { data, error } = await supabase
      .from('creator_payout_requests')
      .select('id, amount_usd, amount_ngn, status, bank_name, bank_code, account_number, account_name, creator_name, reference_id, transaction_reference, proof_url, rejection_reason, failure_reason, requested_at, approved_at, finance_assigned_at, processed_at, paid_at, completed_at, risk_score, risk_flags')
      .eq('creator_id', uid)
      .order('requested_at', { ascending: false });

    if (error) {
      if (isMissingTable(error) || isMissingColumn(error)) return res.json({ success: true, data: [] });
      throw error;
    }
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('[studio] getWithdrawals:', err.message);
    if (markSupabaseUnavailable(err, 'studio withdrawals') || isSupabaseNetworkError(err)) {
      return res.json({ success: true, data: [], degraded: true });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── POST /api/studio/withdrawals ─────────────────────────────────────────────

export async function createWithdrawal(req, res) {
  try {
    const uid = req.uid;
    const { amount, bankName, bankCode, accountNumber, accountName } = req.body;
    const payoutsEnabled = await getBooleanSetting('creator_payouts_enabled', true);
    if (!payoutsEnabled) return res.status(403).json({ success: false, message: 'Creator payouts are currently disabled.' });
    const minPayoutUsd = await getNumberSetting('min_payout_usd', 5);

    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0)  return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (amountNum < minPayoutUsd)      return res.status(400).json({ success: false, message: `Minimum withdrawal is $${minPayoutUsd.toFixed(2)}` });
    if (!bankName?.trim())             return res.status(400).json({ success: false, message: 'Bank name is required' });
    if (!accountNumber?.trim())        return res.status(400).json({ success: false, message: 'Account number is required' });
    if (!accountName?.trim())          return res.status(400).json({ success: false, message: 'Account holder name is required' });
    if (!studioSupabaseReady())        return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please try again shortly.' });

    const data = await createCreatorWithdrawalRequest({
      creatorId: uid,
      amount: amountNum,
      bankName,
      bankCode,
      accountNumber,
      accountName,
      req,
      io: req.app?.get('io'),
    });

    return res.status(201).json({
      success: true,
      data,
      message: 'Withdrawal request submitted. Payment processing may take up to 24 hours after approval.',
    });
  } catch (err) {
    console.error('[studio] createWithdrawal:', err.message);
    if (markSupabaseUnavailable(err, 'studio withdrawal create') || isSupabaseNetworkError(err)) {
      return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please try again shortly.' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/settings ─────────────────────────────────────────────────

export async function getSettings(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.json({ success: true, data: {}, degraded: true });

    let { data, error } = await supabase
      .from('creators')
      .select('display_name, bio, social_links, notification_prefs')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) return res.json({ success: true, data: {} });
      // social_links / notification_prefs columns not yet added — retry with base columns only
      if (isMissingColumn(error)) {
        const retry = await supabase
          .from('creators')
          .select('display_name, bio')
          .eq('user_id', uid)
          .maybeSingle();
        if (retry.error && !isMissingTable(retry.error)) throw retry.error;
        data = retry.data;
      } else {
        throw error;
      }
    }
    return res.json({ success: true, data: data || {} });
  } catch (err) {
    console.error('[studio] getSettings:', err.message);
    if (markSupabaseUnavailable(err, 'studio settings') || isSupabaseNetworkError(err)) {
      return res.json({ success: true, data: {}, degraded: true });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── PATCH /api/studio/settings ───────────────────────────────────────────────

export async function updateSettings(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please try again shortly.' });

    const { displayName, bio, socialLinks } = req.body;
    const update = { user_id: uid, updated_at: new Date().toISOString() };

    if (typeof displayName === 'string') update.display_name = displayName.trim().slice(0, 100);
    if (typeof bio         === 'string') update.bio          = bio.trim().slice(0, 500);
    if (socialLinks && typeof socialLinks === 'object') update.social_links = socialLinks;

    let { error } = await supabase
      .from('creators')
      .upsert(update, { onConflict: 'user_id' });

    // social_links column not yet added — retry without it
    if (error && isMissingColumn(error)) {
      const safeUpdate = { ...update };
      delete safeUpdate.social_links;
      delete safeUpdate.notification_prefs;
      ({ error } = await supabase.from('creators').upsert(safeUpdate, { onConflict: 'user_id' }));
    }

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('[studio] updateSettings:', err.message);
    if (markSupabaseUnavailable(err, 'studio settings update') || isSupabaseNetworkError(err)) {
      return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please try again shortly.' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}
