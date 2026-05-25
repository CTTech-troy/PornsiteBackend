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
  getPayoutById,
} from '../services/payoutWorkflow.service.js';
import { getReceiptForPayout, streamReceiptPdf } from '../services/receiptService.js';
import { normalizeCreatorApplicationKyc } from '../services/payoutKyc.service.js';
import {
  dedupeEarningRows,
  groupEarningRowsBySource,
  sumEarningRowsUsd,
} from '../services/revenueCalculation.service.js';
import { enqueueSearchDocument } from '../services/searchIndex.service.js';
import {
  listFlutterwaveBanks,
  resolveFlutterwaveBankAccount,
} from '../services/flutterwaveTransfer.service.js';

function isMissingColumn(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === '42703' ||
    err?.code === 'PGRST204' ||
    /could not find the '[^']+' column/i.test(msg) ||
    (/column/i.test(msg) && /schema cache|does not exist/i.test(msg))
  );
}

function isMissingTable(err) {
  const msg = String(err?.message || '');
  if (isMissingColumn(err)) return false;
  return (
    err?.code === '42P01' ||
    err?.code === 'PGRST200' ||
    (msg.includes('schema cache') && /relation|table/i.test(msg))
  );
}

function extractMissingColumnName(err) {
  const msg = String(err?.message || '');
  const quoted = msg.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const named = msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
  if (named?.[1]) return named[1];
  return null;
}

function emptyStudioEarnings() {
  return { total: 0, available: 0, pending: 0, processing: 0, withdrawn: 0, bySource: [], rows: [] };
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
  try {
    if (process.env.FLUTTERWAVE_SECRET_KEY) {
      const banks = await listFlutterwaveBanks('NG');
      if (banks.length) return res.json({ banks, provider: 'flutterwave' });
    }
  } catch (_) { /* fall through to Paystack / hardcoded */ }

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
          return res.json({ banks, provider: 'paystack' });
        }
      }
    }
  } catch (_) { /* fall through to hardcoded */ }
  return res.json({ banks: NIGERIAN_BANKS, provider: 'static' });
}

// ── POST /api/studio/banks/verify ─────────────────────────────────────────────

export async function verifyBankAccount(req, res) {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'accountNumber and bankCode are required' });
    }

    if (process.env.FLUTTERWAVE_SECRET_KEY) {
      try {
        const account = await resolveFlutterwaveBankAccount({ accountNumber, bankCode });
        return res.json({
          success: true,
          accountName: account.accountName,
          accountNumber: account.accountNumber || accountNumber,
          provider: 'flutterwave',
        });
      } catch (_) {
        // Fall back to Paystack when Flutterwave account resolution is unavailable.
      }
    }

    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackKey) {
      return res.status(503).json({ success: false, message: 'Bank verification unavailable. Configure Flutterwave or Paystack credentials.' });
    }
    const r = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: { Authorization: `Bearer ${paystackKey}` }, signal: AbortSignal.timeout(8000) },
    );
    const json = await r.json();
    if (!r.ok || !json.status) {
      return res.status(400).json({ success: false, message: json.message || 'Account verification failed.' });
    }
    return res.json({ success: true, accountName: json.data.account_name, provider: 'paystack' });
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

function toMillis(value) {
  if (value == null || value === '') return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value > 9999999999 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatDurationSeconds(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function mapSupabaseCreatorVideo(row = {}) {
  const videoId = String(row.video_id || row.id || '').trim();
  if (!videoId) return null;
  const durationSeconds = Number(row.duration_seconds ?? row.duration ?? row.duration_sec ?? 0) || 0;
  const tokenPrice = Number(row.token_price ?? row.coin_price ?? 0) || 0;
  const accessType = String(row.access_type || '').trim().toLowerCase().replace(/-/g, '_');
  const isPremiumContent =
    row.is_premium_content === true ||
    tokenPrice > 0 ||
    ['premium', 'members_only', 'coin_unlock'].includes(accessType);
  return {
    videoId,
    userId: row.user_id,
    title: row.title || 'Untitled',
    description: row.description || '',
    totalViews: Number(row.views_count ?? row.totalViews ?? row.views ?? 0) || 0,
    views: Number(row.views_count ?? row.totalViews ?? row.views ?? 0) || 0,
    totalLikes: Number(row.likes_count ?? row.totalLikes ?? 0) || 0,
    totalComments: Number(row.comments_count ?? row.totalComments ?? 0) || 0,
    thumbnailUrl: row.thumbnail_url || row.thumbnailUrl || row.thumbnail || null,
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    isPremiumContent,
    tokenPrice,
    isLive: row.is_live === true || row.status === 'published',
    status: row.status || (row.is_live === true ? 'published' : 'draft'),
    createdAt: toMillis(row.created_at || row.createdAt || row.updated_at || row.updatedAt),
    source: 'supabase',
  };
}

async function getSupabaseCreatorVideos(uid) {
  if (!uid || !studioSupabaseReady()) return [];
  try {
    const { data, error } = await supabase
      .from('tiktok_videos')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });
    if (error) {
      if (isMissingTable(error) || isMissingColumn(error)) return [];
      console.warn('[studio] creator videos supabase fallback:', error.message || error);
      return [];
    }
    return (data || []).map(mapSupabaseCreatorVideo).filter(Boolean);
  } catch (err) {
    console.warn('[studio] creator videos supabase error:', err?.message || err);
    return [];
  }
}

async function getLegacyCreatorVideos(uid) {
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

async function getCreatorVideos(uid) {
  const [supabaseVideos, legacyVideos] = await Promise.all([
    getSupabaseCreatorVideos(uid),
    getLegacyCreatorVideos(uid),
  ]);
  const seen = new Set();
  const merged = [];
  for (const video of [...supabaseVideos, ...legacyVideos]) {
    const key = String(video?.videoId || video?.id || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(video);
  }
  return merged;
}

function parsePagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function paginatedList(items, query, defaultLimit = 20) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit });
  const total = items.length;
  const data = items.slice(offset, offset + limit);
  return {
    success: true,
    data,
    meta: { page, limit, total, hasMore: offset + limit < total },
  };
}

function groupViewsByDay(videos, days) {
  const map = {};
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    map[d.toISOString().slice(0, 10)] = 0;
  }
  for (const v of videos) {
    const ts = v.createdAt;
    if (!ts) continue;
    const key = new Date(Number(ts)).toISOString().slice(0, 10);
    if (key in map) map[key] += Number(v.totalViews ?? v.views) || 0;
  }
  return Object.entries(map).map(([date, value]) => ({
    date,
    value,
    label: date.slice(5),
  }));
}

function maskEmail(email) {
  const e = String(email || '').trim();
  if (!e.includes('@')) return e ? '***' : '';
  const [local, domain] = e.split('@');
  const shown = local.length <= 2 ? '*' : `${local.slice(0, 2)}***`;
  return `${shown}@${domain}`;
}

function maskPhone(phone) {
  const p = String(phone || '').replace(/\s/g, '');
  if (p.length < 4) return p ? '****' : '';
  return `****${p.slice(-4)}`;
}

function groupEarningsByDay(rows, days) {
  const map = {};
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    map[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of dedupeEarningRows(rows)) {
    const key = String(row.created_at || '').slice(0, 10);
    if (key in map) map[key] += Number(row.amount_usd) || 0;
  }
  return Object.entries(map).map(([date, value]) => ({
    date,
    value: parseFloat(value.toFixed(4)),
    label: date.slice(5), // MM-DD
  }));
}

function premiumPurchaseToEarningRow(row = {}) {
  const id = String(row.id || '').trim();
  if (!id) return null;
  const amount = Number(row.creator_revenue_usd ?? row.creatorRevenueUsd ?? 0) || 0;
  if (amount <= 0) return null;
  return {
    id: `premium-${id}`,
    creator_id: row.creator_id,
    amount_usd: amount,
    gross_usd: Number(row.purchase_amount_usd ?? row.purchaseAmountUsd ?? amount) || amount,
    platform_fee_usd: Number(row.platform_revenue_usd ?? row.platformRevenueUsd ?? 0) || 0,
    source: 'video_purchase',
    reference_id: `premium_purchase:${id}`,
    created_at: row.purchased_at || row.created_at || new Date().toISOString(),
    metadata: { videoId: row.video_id || null, fallback: 'premium_video_purchases' },
  };
}

function mergePremiumPurchaseEarnings(earnings = [], purchases = []) {
  const rows = dedupeEarningRows(earnings || []);
  const refs = new Set(rows.map((row) => row.reference_id ? String(row.reference_id) : '').filter(Boolean));
  for (const purchase of purchases || []) {
    const row = premiumPurchaseToEarningRow(purchase);
    if (!row || refs.has(row.reference_id)) continue;
    refs.add(row.reference_id);
    rows.push(row);
  }
  return dedupeEarningRows(rows);
}

async function getCreatorEarningsRows(uid, { since = null, order = 'desc' } = {}) {
  if (!studioSupabaseReady()) return [];
  let earningsQuery = supabase
    .from('creator_earnings')
    .select('*')
    .eq('creator_id', uid);
  let purchaseQuery = supabase
    .from('premium_video_purchases')
    .select('id, creator_id, video_id, purchase_amount_usd, creator_revenue_usd, platform_revenue_usd, purchased_at, created_at')
    .eq('creator_id', uid);
  if (since) {
    const iso = since instanceof Date ? since.toISOString() : String(since);
    earningsQuery = earningsQuery.gte('created_at', iso);
    purchaseQuery = purchaseQuery.gte('purchased_at', iso);
  }
  earningsQuery = earningsQuery.order('created_at', { ascending: order === 'asc' });
  purchaseQuery = purchaseQuery.order('purchased_at', { ascending: order === 'asc' });

  const [earningsRes, purchasesRes] = await Promise.all([
    safeStudioQuery('studio creator earnings', earningsQuery, { data: [], error: null, degraded: true }),
    safeStudioQuery('studio premium purchase earnings fallback', purchaseQuery, { data: [], error: null, degraded: true }),
  ]);
  if (earningsRes.error && !isMissingTable(earningsRes.error) && !isMissingColumn(earningsRes.error)) throw earningsRes.error;
  const earnings = earningsRes.error ? [] : (earningsRes.data || []);
  const purchases = purchasesRes?.error && (isMissingTable(purchasesRes.error) || isMissingColumn(purchasesRes.error))
    ? []
    : (purchasesRes?.data || []);
  return mergePremiumPurchaseEarnings(earnings, purchases);
}

// ── GET /api/studio/overview ─────────────────────────────────────────────────

export async function getOverview(req, res) {
  try {
    const uid = req.uid;

    const [videos, userRes, earnings] = await Promise.all([
      getCreatorVideos(uid),
      safeStudioQuery(
        'studio overview user profile',
        () => supabase.from('users').select('followers, following, coin_balance').eq('id', uid).maybeSingle(),
        { data: null }
      ),
      getCreatorEarningsRows(uid),
    ]);

    const user     = userRes?.data || {};
    const followers = Number(user.followers) || 0;

    const totalViews  = videos.reduce((s, v) => s + (Number(v.totalViews ?? v.views) || 0), 0);
    const totalLikes  = videos.reduce((s, v) => s + (Number(v.totalLikes) || 0), 0);
    const premiumVids = videos.filter(v => v.isPremiumContent);

    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const monthlyEarnings = sumEarningRowsUsd(earnings, { since: thirtyAgo });

    let payoutBalances = {
      total: 0,
      available: 0,
      pending: 0,
      processing: 0,
      withdrawn: 0,
    };
    try {
      payoutBalances = await getCreatorPayoutBalances(uid);
    } catch (balanceErr) {
      console.warn('[studio] overview payout balance fallback:', balanceErr?.message || balanceErr);
      payoutBalances.total = sumEarningRowsUsd(earnings);
      payoutBalances.available = payoutBalances.total;
    }
    const computedEarningsTotal = sumEarningRowsUsd(earnings);
    if (computedEarningsTotal > Number(payoutBalances.total || 0)) {
      const committed = Number(payoutBalances.pending || 0)
        + Number(payoutBalances.processing || 0)
        + Number(payoutBalances.withdrawn || 0);
      payoutBalances.total = computedEarningsTotal;
      payoutBalances.available = Math.max(0, computedEarningsTotal - committed);
    }

    const totalEarnings = Number(payoutBalances.total || 0);

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
        durationSeconds: Number(v.durationSeconds ?? v.duration_seconds ?? 0) || 0,
        duration: formatDurationSeconds(v.durationSeconds ?? v.duration_seconds ?? v.duration ?? 0),
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
        totalEarnings:   parseFloat(totalEarnings.toFixed(2)),
        availableEarnings: parseFloat(Number(payoutBalances.available || 0).toFixed(2)),
        pendingEarnings: parseFloat(Number(payoutBalances.pending || 0).toFixed(2)),
        processingEarnings: parseFloat(Number(payoutBalances.processing || 0).toFixed(2)),
        withdrawnEarnings: parseFloat(Number(payoutBalances.withdrawn || 0).toFixed(2)),
        monthlyEarnings: parseFloat(monthlyEarnings.toFixed(2)),
        pendingWithdrawals: parseFloat(Number(payoutBalances.pending || 0).toFixed(2)),
        pendingPayouts: parseFloat(Number(payoutBalances.pending || 0).toFixed(2)),
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

    const [videos, userRes, earningsRows] = await Promise.all([
      getCreatorVideos(uid),
      safeStudioQuery(
        'studio analytics user profile',
        () => supabase.from('users').select('followers').eq('id', uid).maybeSingle(),
        { data: null }
      ),
      getCreatorEarningsRows(uid, { since, order: 'asc' }),
    ]);

    const earningsRowsDeduped = dedupeEarningRows(earningsRows || []);
    const followers    = Number(userRes?.data?.followers) || 0;
    const totalViews   = videos.reduce((s, v) => s + (Number(v.totalViews ?? v.views) || 0), 0);
    const totalLikes   = videos.reduce((s, v) => s + (Number(v.totalLikes) || 0), 0);

    const earningsTrend  = groupEarningsByDay(earningsRowsDeduped, days);

    const sourceMap = groupEarningRowsBySource(earningsRowsDeduped);
    const earningsBySource = Object.entries(sourceMap).map(([name, value]) => ({
      name:  name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
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

    const periodEarnings = sumEarningRowsUsd(earningsRowsDeduped);
    const level   = computeLevel(followers, totalViews);
    const lvlIdx  = CREATOR_LEVELS.indexOf(level);
    const nextLvl = lvlIdx < CREATOR_LEVELS.length - 1 ? CREATOR_LEVELS[lvlIdx + 1] : null;

    const viewsTrend = groupViewsByDay(videos, days);

    return res.json({
      success: true,
      data: {
        earningsTrend,
        viewsTrend,
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
        thumbnailUrl:   v.thumbnailUrl || v.thumbnail || null,
        durationSeconds: Number(v.durationSeconds ?? v.duration_seconds ?? 0) || 0,
        duration:       formatDurationSeconds(v.durationSeconds ?? v.duration_seconds ?? v.duration ?? 0),
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

    const [earningsRows, pendingRes] = await Promise.all([
      getCreatorEarningsRows(uid),
      safeStudioQuery(
        'studio earnings pending payouts',
        supabase.from('creator_payout_requests').select('amount_usd, status').eq('creator_id', uid).in('status', ['pending', 'approved', 'processing', 'paid', 'completed']),
        { data: [], error: null, degraded: true }
      ),
    ]);

    const earnings = dedupeEarningRows(earningsRows || []);
    const pending  = pendingRes?.error && (isMissingTable(pendingRes.error) || isMissingColumn(pendingRes.error))
      ? []
      : (pendingRes?.data || []);

    const total          = sumEarningRowsUsd(earnings);
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
    if (total > Number(balances.total || 0)) {
      balances = {
        ...balances,
        total,
        available: Math.max(0, total - pendingAmount - processingAmount - withdrawnAmount),
      };
    }
    const available = balances.available;

    const grouped = groupEarningRowsBySource(earnings);

    let ngnRate = 1600;
    try { ngnRate = await getNgnToUsdRate(); } catch (_) {}

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    let filtered = earnings;
    if (from && !Number.isNaN(from.getTime())) {
      filtered = filtered.filter((e) => new Date(e.created_at) >= from);
    }
    if (to && !Number.isNaN(to.getTime())) {
      filtered = filtered.filter((e) => new Date(e.created_at) <= to);
    }

    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25 });
    const rowsPage = filtered.slice(offset, offset + limit);

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
        rows: rowsPage,
      },
      meta: { page, limit, total: filtered.length, hasMore: offset + limit < filtered.length },
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
      .select('id, amount_usd, amount_ngn, status, bank_name, bank_code, account_number, account_name, creator_name, reference_id, receipt_number, transaction_reference, proof_url, rejection_reason, failure_reason, requested_at, approved_at, finance_assigned_at, processed_at, paid_at, completed_at, risk_score, risk_flags, remaining_balance_after')
      .eq('creator_id', uid)
      .order('requested_at', { ascending: false });

    if (error) {
      if (isMissingTable(error) || isMissingColumn(error)) return res.json({ success: true, data: [] });
      throw error;
    }
    const list = data || [];
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 15 });
    return res.json({
      success: true,
      data: list.slice(offset, offset + limit),
      meta: { page, limit, total: list.length, hasMore: offset + limit < list.length },
    });
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

// ── GET /api/studio/withdrawals/:id/receipt ──────────────────────────────────

export async function getWithdrawalReceipt(req, res) {
  try {
    const uid = req.uid;
    const payout = await getPayoutById(req.params.id);
    if (!payout || payout.creator_id !== uid) {
      return res.status(404).json({ success: false, message: 'Withdrawal not found.' });
    }
    if (!['paid', 'completed', 'rejected'].includes(payout.status)) {
      return res.status(400).json({ success: false, message: 'Receipt is only available for paid or rejected withdrawals.' });
    }
    const receipt = await getReceiptForPayout(payout.id);
    if (!receipt) return res.status(404).json({ success: false, message: 'Receipt not found.' });
    if (req.path.endsWith('.pdf') || req.query.format === 'pdf') {
      return streamReceiptPdf(res, receipt, receipt.metadata);
    }
    return res.json({
      success: true,
      receipt: {
        id: receipt.id,
        receiptNumber: receipt.receipt_number,
        type: receipt.type,
        createdAt: receipt.created_at,
        metadata: receipt.metadata,
      },
      payout: { id: payout.id, status: payout.status, amount_usd: payout.amount_usd },
    });
  } catch (err) {
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

    const { displayName, bio, socialLinks, notificationPrefs } = req.body;
    const update = { user_id: uid, updated_at: new Date().toISOString() };

    if (typeof displayName === 'string') update.display_name = displayName.trim().slice(0, 100);
    if (typeof bio         === 'string') update.bio          = bio.trim().slice(0, 500);
    if (socialLinks && typeof socialLinks === 'object') update.social_links = socialLinks;
    if (notificationPrefs && typeof notificationPrefs === 'object') {
      update.notification_prefs = notificationPrefs;
    }

    let payload = { ...update };
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { error } = await supabase.from('creators').upsert(payload, { onConflict: 'user_id' });
      if (!error) {
        enqueueSearchDocument('creator', uid, 'upsert').catch(() => {});
        const skipped = [];
        if (socialLinks && !('social_links' in payload)) skipped.push('social_links');
        if (notificationPrefs && !('notification_prefs' in payload)) skipped.push('notification_prefs');
        return res.json({
          success: true,
          ...(skipped.length
            ? { warning: `Saved profile without: ${skipped.join(', ')}. Run Supabase migration 20260604000000_creators_studio_settings.sql.` }
            : {}),
        });
      }
      lastError = error;
      if (!isMissingColumn(error)) break;
      const missing = extractMissingColumnName(error);
      if (missing && missing in payload) {
        delete payload[missing];
        continue;
      }
      if ('social_links' in payload) {
        delete payload.social_links;
        continue;
      }
      if ('notification_prefs' in payload) {
        delete payload.notification_prefs;
        continue;
      }
      break;
    }

    if (lastError) throw lastError;
    return res.json({ success: true });
  } catch (err) {
    console.error('[studio] updateSettings:', err.message);
    if (markSupabaseUnavailable(err, 'studio settings update') || isSupabaseNetworkError(err)) {
      return res.status(503).json({ success: false, message: 'Database temporarily unavailable. Please try again shortly.' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/notifications ─────────────────────────────────────────────

export async function getNotifications(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) {
      return res.json({ success: true, data: [], meta: { page: 1, limit: 20, total: 0, hasMore: false } });
    }

    const { data, error } = await supabase
      .from('creator_notifications')
      .select('id, type, title, message, data, read_at, created_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingTable(error)) {
        return res.json({ success: true, data: [], meta: { page: 1, limit: 20, total: 0, hasMore: false } });
      }
      throw error;
    }

    const mapped = (data || []).map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      read: Boolean(n.read_at),
      createdAt: n.created_at,
    }));

    return res.json(paginatedList(mapped, req.query, 20));
  } catch (err) {
    console.error('[studio] getNotifications:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function markNotificationRead(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const { error } = await supabase
      .from('creator_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', uid);

    if (error && !isMissingTable(error)) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function markAllNotificationsRead(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const { error } = await supabase
      .from('creator_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', uid)
      .is('read_at', null);

    if (error && !isMissingTable(error)) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getContentAnalytics(req, res) {
  try {
    const uid = req.uid;
    const videos = await getCreatorVideos(uid);
    const items = [...videos]
      .map((v) => {
        const views = Number(v.totalViews ?? v.views) || 0;
        const likes = Number(v.totalLikes) || 0;
        const comments = Number(v.totalComments) || 0;
        return {
          id: v.videoId,
          title: v.title || 'Untitled',
          views,
          likes,
          comments,
          thumbnail: v.thumbnailUrl || v.thumbnail || null,
          isPremium: Boolean(v.isPremiumContent),
          isPublished: v.isLive !== false,
          createdAt: v.createdAt,
          engagementRate: views > 0 ? Number(((likes / views) * 100).toFixed(1)) : 0,
        };
      })
      .sort((a, b) => b.views - a.views);

    const summary = {
      totalVideos: items.length,
      totalViews: items.reduce((s, v) => s + v.views, 0),
      totalLikes: items.reduce((s, v) => s + v.likes, 0),
      avgEngagement: items.length
        ? Number((items.reduce((s, v) => s + v.engagementRate, 0) / items.length).toFixed(1))
        : 0,
    };

    const paged = paginatedList(items, req.query, 20);
    return res.json({ ...paged, summary });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getAudience(req, res) {
  try {
    const uid = req.uid;
    const [videos, userRes] = await Promise.all([
      getCreatorVideos(uid),
      safeStudioQuery(
        'studio audience user',
        () => supabase.from('users').select('followers, following, country').eq('id', uid).maybeSingle(),
        { data: null },
      ),
    ]);

    const user = userRes?.data || {};
    const followers = Number(user.followers) || 0;
    const totalViews = videos.reduce((s, v) => s + (Number(v.totalViews ?? v.views) || 0), 0);
    const totalLikes = videos.reduce((s, v) => s + (Number(v.totalLikes) || 0), 0);

    const topVideos = [...videos]
      .sort((a, b) => (Number(b.totalViews ?? b.views) || 0) - (Number(a.totalViews ?? a.views) || 0))
      .slice(0, 5)
      .map((v) => ({
        id: v.videoId,
        title: v.title || 'Untitled',
        views: Number(v.totalViews ?? v.views) || 0,
      }));

    return res.json({
      success: true,
      data: {
        followers,
        following: Number(user.following) || 0,
        totalViews,
        engagementRate: totalViews > 0 ? Number(((totalLikes / totalViews) * 100).toFixed(1)) : 0,
        primaryCountry: user.country || null,
        deviceSplit: { web: 62, mobile: 38 },
        topVideos,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getRevenueReport(req, res) {
  try {
    const uid = req.uid;
    const period = ['7d', '30d', '90d', '1y'].includes(req.query.period) ? req.query.period : '30d';
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period];
    const since = new Date();
    since.setDate(since.getDate() - days);

    if (!studioSupabaseReady()) {
      return res.json({ success: true, data: { period, monthly: [], totals: {}, withdrawals: [] }, degraded: true });
    }

    const [earningsRes, withdrawalsRes] = await Promise.all([
      safeStudioQuery(
        'studio revenue earnings',
        () => supabase.from('creator_earnings').select('amount_usd, source, created_at, reference_id').eq('creator_id', uid).gte('created_at', since.toISOString()),
        { data: [] },
      ),
      safeStudioQuery(
        'studio revenue withdrawals',
        () => supabase.from('creator_payout_requests').select('amount_usd, status, requested_at, paid_at').eq('creator_id', uid).gte('requested_at', since.toISOString()).order('requested_at', { ascending: false }),
        { data: [] },
      ),
    ]);

    const earnings = dedupeEarningRows(earningsRes?.data || []);
    const withdrawals = withdrawalsRes?.data || [];
    const monthlyMap = {};

    for (const e of earnings) {
      const key = String(e.created_at || '').slice(0, 7);
      if (!key) continue;
      if (!monthlyMap[key]) monthlyMap[key] = { month: key, earnings: 0, platformFees: 0, net: 0 };
      const amt = Number(e.amount_usd) || 0;
      monthlyMap[key].earnings += amt;
      if (String(e.source || '').includes('fee')) monthlyMap[key].platformFees += amt;
      else monthlyMap[key].net += amt;
    }

    const totalEarnings = sumEarningRowsUsd(earnings);
    const totalWithdrawn = withdrawals
      .filter((w) => ['paid', 'completed'].includes(w.status))
      .reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);

    return res.json({
      success: true,
      data: {
        period,
        monthly: Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month)),
        totals: {
          grossEarnings: parseFloat(totalEarnings.toFixed(2)),
          withdrawn: parseFloat(totalWithdrawn.toFixed(2)),
          pendingWithdrawals: parseFloat(
            withdrawals.filter((w) => w.status === 'pending').reduce((s, w) => s + (Number(w.amount_usd) || 0), 0).toFixed(2),
          ),
        },
        withdrawals: withdrawals.slice(0, 50),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getSubscriptions(req, res) {
  try {
    const uid = req.uid;
    if (!studioSupabaseReady()) {
      return res.json({
        success: true,
        data: [],
        summary: { active: 0, mrr: 0 },
        meta: { page: 1, limit: 20, total: 0, hasMore: false },
      });
    }

    let result = await supabase
      .from('user_memberships')
      .select('id, user_id, plan_id, amount_paid_usd, status, started_at, expires_at')
      .eq('creator_id', uid)
      .eq('status', 'active')
      .order('started_at', { ascending: false });

    if (result.error && isMissingColumn(result.error)) {
      return res.json({
        success: true,
        data: [],
        summary: { active: 0, mrr: 0 },
        meta: { page: 1, limit: 20, total: 0, hasMore: false },
        note: 'Per-creator subscriptions require creator_id on memberships.',
      });
    }

    if (result.error) {
      if (isMissingTable(result.error)) {
        return res.json({
          success: true,
          data: [],
          summary: { active: 0, mrr: 0 },
          meta: { page: 1, limit: 20, total: 0, hasMore: false },
        });
      }
      throw result.error;
    }

    const rows = result.data || [];
    const mrr = rows.reduce((s, r) => s + (Number(r.amount_paid_usd) || 0), 0);
    const paged = paginatedList(
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        planId: r.plan_id,
        amountUsd: Number(r.amount_paid_usd) || 0,
        status: r.status,
        startedAt: r.started_at,
        expiresAt: r.expires_at,
      })),
      req.query,
      20,
    );

    return res.json({
      ...paged,
      summary: { active: rows.length, mrr: parseFloat(mrr.toFixed(2)) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getVerification(req, res) {
  try {
    const uid = req.uid;
    let creatorStatus = 'none';
    let applicationStatus = null;
    let kycSummary = null;

    if (studioSupabaseReady()) {
      const [userRes, appRes] = await Promise.all([
        supabase.from('users').select('creator, verified, email').eq('id', uid).maybeSingle(),
        supabase.from('creator_applications').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      const user = userRes?.data;
      if (user?.creator === true || user?.verified === 'approved' || user?.verified === true) {
        creatorStatus = 'approved';
      } else if (user?.verified === 'pending') {
        creatorStatus = 'pending';
      } else if (user?.verified === 'rejected') {
        creatorStatus = 'rejected';
      }

      const app = appRes?.data;
      if (app) {
        applicationStatus = app.status;
        const kyc = normalizeCreatorApplicationKyc(app, user);
        if (kyc) {
          kycSummary = {
            applicationId: kyc.applicationId,
            applicationStatus: kyc.applicationStatus,
            submittedAt: kyc.submittedAt,
            fullName: kyc.fullName,
            email: maskEmail(kyc.email),
            phone: maskPhone(kyc.phone),
            country: kyc.country,
            idType: kyc.idType,
            creatorType: kyc.creatorType,
            termsAccepted: kyc.termsAccepted,
          };
        }
      }
    }

    return res.json({
      success: true,
      data: { creatorStatus, applicationStatus, kycSummary },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function updateVideo(req, res) {
  try {
    const uid = req.uid;
    const videoId = req.params.id;

    if (studioSupabaseReady()) {
      const { data: existing, error: lookupError } = await supabase
        .from('tiktok_videos')
        .select('video_id,user_id')
        .eq('video_id', videoId)
        .maybeSingle();
      if (lookupError && !isMissingTable(lookupError) && !isMissingColumn(lookupError)) throw lookupError;
      if (existing) {
        if (existing.user_id !== uid) return res.status(404).json({ success: false, message: 'Video not found' });
        const patch = {};
        if (typeof req.body.title === 'string') patch.title = req.body.title.trim().slice(0, 200);
        if (typeof req.body.isPremium === 'boolean') patch.is_premium_content = req.body.isPremium;
        if (req.body.tokenPrice != null) patch.token_price = Math.max(0, Number(req.body.tokenPrice) || 0);
        if (typeof req.body.isPublished === 'boolean') {
          patch.is_live = req.body.isPublished;
          patch.status = req.body.isPublished ? 'published' : 'draft';
        }
        if (!Object.keys(patch).length) {
          return res.status(400).json({ success: false, message: 'No valid fields to update' });
        }
        const { error: updateError } = await supabase
          .from('tiktok_videos')
          .update(patch)
          .eq('video_id', videoId)
          .eq('user_id', uid);
        if (updateError) throw updateError;
        return res.json({ success: true, data: { id: videoId, ...patch } });
      }
    }

    const ref = videosRef();
    if (!ref) return res.status(503).json({ success: false, message: 'Video storage unavailable' });

    const snap = await ref.child(videoId).once('value');
    const existing = snap.val();
    if (!existing || existing.userId !== uid) {
      return res.status(404).json({ success: false, message: 'Video not found' });
    }

    const patch = {};
    if (typeof req.body.title === 'string') patch.title = req.body.title.trim().slice(0, 200);
    if (typeof req.body.isPremium === 'boolean') patch.isPremiumContent = req.body.isPremium;
    if (req.body.tokenPrice != null) patch.tokenPrice = Math.max(0, Number(req.body.tokenPrice) || 0);
    if (typeof req.body.isPublished === 'boolean') patch.isLive = req.body.isPublished;

    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    await ref.child(videoId).update(patch);
    return res.json({ success: true, data: { id: videoId, ...patch } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getAnnouncements(req, res) {
  return res.json({
    success: true,
    data: [
      {
        id: 'payout-receipts',
        title: 'Payout receipts available',
        message: 'Download PDF receipts from the Payouts page after withdrawals are processed.',
        type: 'info',
      },
      {
        id: 'studio-launch',
        title: 'Creator Studio updated',
        message: 'New analytics, revenue reports, and notification center are now live.',
        type: 'success',
      },
    ],
  });
}

export async function getActivity(req, res) {
  try {
    const uid = req.uid;
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const items = [];

    if (studioSupabaseReady()) {
      const [notifsRes, purchasesRes] = await Promise.all([
        supabase
          .from('creator_notifications')
          .select('id, type, title, message, created_at')
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('premium_video_purchases')
          .select('id, video_title, purchase_amount_usd, creator_revenue_usd, purchased_at, metadata')
          .eq('creator_id', uid)
          .eq('access_status', 'active')
          .order('purchased_at', { ascending: false })
          .limit(limit),
      ]);

      (notifsRes.data || []).forEach((n) => {
        items.push({
          id: `notif-${n.id}`,
          type: 'notification',
          title: n.title,
          message: n.message,
          createdAt: n.created_at,
        });
      });

      (purchasesRes.data || []).forEach((p) => {
        items.push({
          id: `purchase-${p.id}`,
          type: 'purchase',
          title: 'Premium video sold',
          message: p.video_title || 'Untitled',
          createdAt: p.purchased_at,
          amountUsd: Number(p.creator_revenue_usd || 0),
        });
      });
    }

    const videos = await getCreatorVideos(uid);
    [...videos]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, Math.max(0, limit - items.length))
      .forEach((v) => {
        items.push({
          id: `video-${v.videoId}`,
          type: 'upload',
          title: 'Video published',
          message: v.title || 'Untitled',
          createdAt: v.createdAt ? new Date(Number(v.createdAt)).toISOString() : null,
        });
      });

    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.json({ success: true, data: items.slice(0, limit) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
