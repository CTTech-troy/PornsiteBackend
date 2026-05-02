import { randomUUID } from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';
import { supabase, isConfigured } from '../config/supabase.js';
import { getNgnToUsdRate } from '../utils/exchangeRate.js';
import {
  sendPayoutRequestedEmail,
} from '../services/emailService.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

function isMissingColumn(err) {
  return err?.code === '42703';
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
      isConfigured() ? supabase.from('users').select('followers, following, coin_balance').eq('id', uid).maybeSingle() : Promise.resolve({ data: null }),
      isConfigured() ? supabase.from('creator_earnings').select('amount_usd, source, created_at').eq('creator_id', uid) : Promise.resolve({ data: [] }),
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
      isConfigured() ? supabase.from('users').select('followers').eq('id', uid).maybeSingle() : Promise.resolve({ data: null }),
      isConfigured()
        ? supabase.from('creator_earnings').select('amount_usd, source, created_at').eq('creator_id', uid).gte('created_at', since.toISOString()).order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),
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
    if (!isConfigured()) return res.json({ success: true, data: { total: 0, available: 0, pending: 0, bySource: [], rows: [] } });

    const [earningsRes, pendingRes] = await Promise.all([
      supabase.from('creator_earnings').select('*').eq('creator_id', uid).order('created_at', { ascending: false }),
      supabase.from('creator_payout_requests').select('amount_usd, status').eq('creator_id', uid).in('status', ['pending', 'processing']),
    ]);

    if (earningsRes.error) {
      if (isMissingTable(earningsRes.error)) {
        return res.json({ success: true, data: { total: 0, available: 0, pending: 0, bySource: [], rows: [] } });
      }
      throw earningsRes.error;
    }

    const earnings = earningsRes?.data || [];
    const pending  = pendingRes?.data  || [];

    const total          = earnings.reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const pendingAmount  = pending.reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);
    const available      = Math.max(0, total - pendingAmount);

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
        total:    parseFloat(total.toFixed(2)),
        available: parseFloat(available.toFixed(2)),
        pending:  parseFloat(pendingAmount.toFixed(2)),
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
    if (!isConfigured()) return res.json({ success: true, data: [] });

    const { data, error } = await supabase
      .from('creator_payout_requests')
      .select('id, amount_usd, amount_ngn, status, bank_name, bank_code, account_number, account_name, creator_name, reference_id, rejection_reason, requested_at, processed_at')
      .eq('creator_id', uid)
      .order('requested_at', { ascending: false });

    if (error) {
      if (isMissingTable(error) || isMissingColumn(error)) return res.json({ success: true, data: [] });
      throw error;
    }
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('[studio] getWithdrawals:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── POST /api/studio/withdrawals ─────────────────────────────────────────────

export async function createWithdrawal(req, res) {
  try {
    const uid = req.uid;
    const { amount, bankName, bankCode, accountNumber, accountName } = req.body;

    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0)  return res.status(400).json({ success: false, message: 'Invalid amount' });
    if (amountNum < 5)                 return res.status(400).json({ success: false, message: 'Minimum withdrawal is $5.00' });
    if (!bankName?.trim())             return res.status(400).json({ success: false, message: 'Bank name is required' });
    if (!accountNumber?.trim())        return res.status(400).json({ success: false, message: 'Account number is required' });
    if (!accountName?.trim())          return res.status(400).json({ success: false, message: 'Account holder name is required' });
    if (!isConfigured())               return res.status(503).json({ success: false, message: 'Database not configured' });

    // Validate no duplicate pending request
    const { data: existing } = await supabase
      .from('creator_payout_requests')
      .select('id')
      .eq('creator_id', uid)
      .eq('status', 'pending')
      .limit(1);
    if (existing && existing.length > 0) {
      return res.status(409).json({ success: false, message: 'You already have a pending withdrawal request. Please wait for it to be processed.' });
    }

    // Compute available balance
    const [earningsRes, pendingRes, userRes] = await Promise.all([
      supabase.from('creator_earnings').select('amount_usd').eq('creator_id', uid),
      supabase.from('creator_payout_requests').select('amount_usd').eq('creator_id', uid).in('status', ['pending', 'processing']),
      isConfigured() ? supabase.from('users').select('email, username, display_name').eq('id', uid).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const totalEarned   = (earningsRes?.data || []).reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const pendingAmount = (pendingRes?.data  || []).reduce((s, w) => s + (Number(w.amount_usd) || 0), 0);
    const available     = Math.max(0, totalEarned - pendingAmount);

    if (amountNum > available) {
      return res.status(400).json({ success: false, message: `Insufficient balance. Available: $${available.toFixed(2)}` });
    }

    // Compute NGN equivalent
    let amountNgn = null;
    try {
      const rate = await getNgnToUsdRate();
      amountNgn = parseFloat((amountNum * rate).toFixed(2));
    } catch (_) {}

    const referenceId = `XPAY-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const creatorEmail = userRes?.data?.email || null;
    const creatorDisplayName = userRes?.data?.display_name || userRes?.data?.username || accountName.trim();

    const { data, error } = await supabase
      .from('creator_payout_requests')
      .insert({
        creator_id:     uid,
        creator_name:   creatorDisplayName,
        creator_email:  creatorEmail,
        bank_name:      bankName.trim(),
        bank_code:      bankCode?.trim() || null,
        account_number: accountNumber.trim(),
        account_name:   accountName.trim(),
        amount_usd:     amountNum,
        amount_ngn:     amountNgn,
        reference_id:   referenceId,
        method:         'bank_transfer',
        status:         'pending',
      })
      .select()
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) {
        return res.status(503).json({ success: false, message: 'Payout system not available yet. Please contact support.' });
      }
      // Fallback: insert without new columns if they don't exist yet
      if (isMissingColumn(error)) {
        const { data: fallbackData, error: fallbackErr } = await supabase
          .from('creator_payout_requests')
          .insert({
            creator_id:     uid,
            creator_name:   creatorDisplayName,
            bank_name:      bankName.trim(),
            account_number: accountNumber.trim(),
            amount_usd:     amountNum,
            method:         'bank_transfer',
            status:         'pending',
          })
          .select()
          .maybeSingle();
        if (fallbackErr) throw fallbackErr;
        return res.status(201).json({ success: true, data: fallbackData });
      }
      throw error;
    }

    // Send confirmation email (non-blocking)
    if (creatorEmail) {
      sendPayoutRequestedEmail({
        to:            creatorEmail,
        name:          creatorDisplayName,
        amountUsd:     amountNum,
        amountNgn,
        bankName:      bankName.trim(),
        accountNumber: accountNumber.trim(),
        accountName:   accountName.trim(),
        referenceId,
      }).catch(e => console.error('[studio] payout email:', e.message));
    }

    return res.status(201).json({ success: true, data });
  } catch (err) {
    console.error('[studio] createWithdrawal:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/studio/settings ─────────────────────────────────────────────────

export async function getSettings(req, res) {
  try {
    const uid = req.uid;
    if (!isConfigured()) return res.json({ success: true, data: {} });

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
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── PATCH /api/studio/settings ───────────────────────────────────────────────

export async function updateSettings(req, res) {
  try {
    const uid = req.uid;
    if (!isConfigured()) return res.status(503).json({ success: false, message: 'Database not configured' });

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
    return res.status(500).json({ success: false, message: err.message });
  }
}
