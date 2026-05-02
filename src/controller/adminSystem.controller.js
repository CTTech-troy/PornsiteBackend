import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import { getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { pingServices } from '../utils/servicePing.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await supabase.from('admin_audit_logs').insert({
    id: randomUUID(),
    admin_id: adminId || null,
    admin_name: adminName || 'Admin',
    action,
    target_type: targetType,
    target_id: String(targetId || ''),
    details,
    status: 'success',
  });
}

// ── GET /api/admin/system/settings ────────────────────────────────────────────

export async function getSettings(req, res) {
  try {
    const { data, error } = await supabase.from('platform_settings').select('key, value, updated_at');
    if (error) {
      if (isMissingTable(error)) return res.json({ settings: [] });
      return res.status(500).json({ message: error.message });
    }
    return res.json({ settings: data || [] });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/system/settings ────────────────────────────────────────────

export async function updateSettings(req, res) {
  try {
    const { settings } = req.body; // [{ key, value }]
    if (!Array.isArray(settings) || settings.length === 0) {
      return res.status(400).json({ message: 'settings array required.' });
    }

    const upserts = settings.map(s => ({
      key: s.key,
      value: String(s.value ?? ''),
      updated_at: new Date().toISOString(),
      updated_by: req.admin?.name || 'Admin',
    }));

    const { error } = await supabase.from('platform_settings')
      .upsert(upserts, { onConflict: 'key' });

    if (error) {
      if (isMissingTable(error)) return res.status(404).json({ message: 'platform_settings table not found.' });
      return res.status(500).json({ message: error.message });
    }

    await logAction(req.admin?.id, req.admin?.name, 'Settings updated', 'settings', 'platform', {
      keys: settings.map(s => s.key),
    });
    return res.json({ message: 'Settings saved successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/admin/system/settings/:key ───────────────────────────────────────

export async function updateSetting(req, res) {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ message: 'value required.' });

    const { error } = await supabase.from('platform_settings')
      .upsert({ key, value: String(value), updated_at: new Date().toISOString(), updated_by: req.admin?.name || 'Admin' }, { onConflict: 'key' });

    if (error) {
      if (isMissingTable(error)) return res.status(404).json({ message: 'platform_settings table not found.' });
      return res.status(500).json({ message: error.message });
    }

    await logAction(req.admin?.id, req.admin?.name, `Setting updated: ${key}`, 'settings', key, { value });
    return res.json({ message: 'Setting updated successfully.' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/health ──────────────────────────────────────────────

export async function getSystemHealth(req, res) {
  try {
    const { firebase, supabase: supabaseStatus } = await pingServices();

    // Count active lives
    let activeLives = 0;
    try {
      const { count } = await supabase.from('lives').select('*', { count: 'exact', head: true }).eq('status', 'live');
      activeLives = count || 0;
    } catch (_) {}

    // Count total users
    let totalUsers = 0;
    try {
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      totalUsers = count || 0;
    } catch (_) {}

    // Count active subscriptions
    let activeSubscriptions = 0;
    try {
      const { count } = await supabase.from('user_memberships').select('*', { count: 'exact', head: true }).eq('status', 'active');
      activeSubscriptions = count || 0;
    } catch (_) {}

    // Count pending payouts
    let pendingPayouts = 0;
    try {
      const { count } = await supabase.from('creator_payout_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending');
      pendingPayouts = count || 0;
    } catch (_) {}

    return res.json({
      services: {
        supabase: {
          status: supabaseStatus.status,
          detail: supabaseStatus.detail,
          active: supabaseStatus.status === 'active',
        },
        firebase: {
          status: firebase.status,
          detail: firebase.detail,
          active: firebase.status === 'active',
        },
      },
      stats: {
        totalUsers,
        activeLives,
        activeSubscriptions,
        pendingPayouts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/env ─────────────────────────────────────────────────

export async function getEnvOverview(req, res) {
  try {
    // Return safe, non-sensitive env overview (no secret values)
    const envVars = [
      { key: 'NODE_ENV', value: process.env.NODE_ENV || 'development', sensitive: false },
      { key: 'PORT', value: process.env.PORT || '5043', sensitive: false },
      { key: 'SUPABASE_URL', value: process.env.SUPABASE_URL ? '✓ Set' : '✗ Missing', sensitive: false },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', value: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ Set (hidden)' : '✗ Missing', sensitive: true },
      { key: 'FIREBASE_DATABASE_URL', value: process.env.FIREBASE_DATABASE_URL || '✗ Missing', sensitive: false },
      { key: 'GOOGLE_APPLICATION_CREDENTIALS', value: process.env.GOOGLE_APPLICATION_CREDENTIALS ? '✓ Set' : '✗ Missing', sensitive: false },
      { key: 'ADMIN_JWT_SECRET', value: process.env.ADMIN_JWT_SECRET ? '✓ Set (hidden)' : '⚠ Using fallback', sensitive: true },
      { key: 'LIVEKIT_API_KEY', value: process.env.LIVEKIT_API_KEY ? '✓ Set' : '✗ Missing', sensitive: false },
      { key: 'LIVEKIT_API_SECRET', value: process.env.LIVEKIT_API_SECRET ? '✓ Set (hidden)' : '✗ Missing', sensitive: true },
      { key: 'CORS_ORIGINS', value: process.env.CORS_ORIGINS || '(defaults)', sensitive: false },
      { key: 'PAYSTACK_SECRET_KEY', value: process.env.PAYSTACK_SECRET_KEY ? '✓ Set (hidden)' : '✗ Missing', sensitive: true },
      { key: 'MONNIFY_API_KEY', value: process.env.MONNIFY_API_KEY ? '✓ Set (hidden)' : '✗ Missing', sensitive: true },
      { key: 'RAPIDAPI_VIDEO_KEY', value: process.env.RAPIDAPI_VIDEO_KEY ? '✓ Set (hidden)' : '✗ Missing', sensitive: true },
    ];

    return res.json({
      env: envVars,
      nodeVersion: process.version,
      platform: process.platform,
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/admin-users ─────────────────────────────────────────

export async function getAdminUsers(req, res) {
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, name, email, role, is_active, is_super_admin, created_at, last_login')
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingTable(error)) return res.json({ admins: [] });
      return res.status(500).json({ message: error.message });
    }

    return res.json({ admins: data || [] });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/stats ───────────────────────────────────────────────

async function safeCount(queryBuilder) {
  try {
    const { count, error } = await queryBuilder;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

export async function getStats(req, res) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalUsers, suspendedUsers, bannedUsers, newToday,
      totalCreators, pstarCount, channelCount, pendingApps,
      totalVideos, liveNow, activeMembers, activeAdCampaigns,
    ] = await Promise.all([
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true })),
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('suspended', true)),
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).eq('banned', true)),
      safeCount(supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString())),
      safeCount(supabase.from('creators').select('*', { count: 'exact', head: true })),
      safeCount(supabase.from('creators').select('*', { count: 'exact', head: true }).eq('creator_type', 'pstar')),
      safeCount(supabase.from('creators').select('*', { count: 'exact', head: true }).eq('creator_type', 'channel')),
      safeCount(supabase.from('creator_applications').select('*', { count: 'exact', head: true }).eq('status', 'pending')),
      safeCount(supabase.from('tiktok_videos').select('*', { count: 'exact', head: true })),
      safeCount(supabase.from('lives').select('*', { count: 'exact', head: true }).eq('status', 'live')),
      safeCount(supabase.from('user_memberships').select('*', { count: 'exact', head: true }).eq('status', 'active')),
      safeCount(supabase.from('ad_campaigns').select('*', { count: 'exact', head: true }).eq('status', 'active')),
    ]);

    // Active = total minus explicitly banned/suspended users
    const activeUsers = Math.max(0, totalUsers - suspendedUsers - bannedUsers);

    return res.json({
      users:       { total: totalUsers, active: activeUsers, newToday, suspended: suspendedUsers },
      creators:    { total: totalCreators, pstars: pstarCount, channels: channelCount, pendingApplications: pendingApps },
      content:     { videos: totalVideos, liveNow },
      memberships: { active: activeMembers },
      ads:         { activeCampaigns: activeAdCampaigns },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/api-health ─────────────────────────────────────────

export async function getApiHealth(req, res) {
  const t0 = Date.now();

  async function ping(name, fn) {
    const start = Date.now();
    try {
      await fn();
      return { name, status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return { name, status: 'error', latencyMs: Date.now() - start, error: err?.message || 'failed' };
    }
  }

  const checks = await Promise.all([
    ping('Supabase DB', async () => {
      const { error } = await supabase.from('users').select('id').limit(1);
      if (error) throw error;
    }),
    ping('LiveKit', async () => {
      const key = process.env.LIVEKIT_API_KEY;
      const url = process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL || '';
      if (!key || !url) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(url.replace('wss://', 'https://').replace('ws://', 'http://'), { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok && r.status !== 404 && r.status !== 401) throw new Error(`HTTP ${r.status}`);
      } finally { clearTimeout(t); }
    }),
    ping('Paystack', async () => {
      if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch('https://api.paystack.co/bank', {
          headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } finally { clearTimeout(t); }
    }),
    ping('Monnify', async () => {
      if (!process.env.MONNIFY_API_KEY) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch('https://api.monnify.com/api/v1/auth/login', { method: 'POST', signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok && r.status !== 401) throw new Error(`HTTP ${r.status}`);
      } finally { clearTimeout(t); }
    }),
    ping('Resend (Email)', async () => {
      if (!process.env.RESEND_API_KEY) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch('https://api.resend.com/emails', {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok && r.status !== 405) throw new Error(`HTTP ${r.status}`);
      } finally { clearTimeout(t); }
    }),
    ping('Firebase RTDB', async () => {
      const dbUrl = process.env.FIREBASE_DATABASE_URL;
      if (!dbUrl) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch(`${dbUrl}/.json?shallow=true`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok && r.status !== 401 && r.status !== 403) throw new Error(`HTTP ${r.status}`);
      } finally { clearTimeout(t); }
    }),
  ]);

  return res.json({ apis: checks, totalMs: Date.now() - t0, timestamp: new Date().toISOString() });
}

// ── GET /api/admin/system/route-latency ──────────────────────────────────────

const MONITORED_ROUTES = [
  // ── Public / no-auth ──────────────────────────────────────────────────────
  { group: 'Health',       path: '/api/health/services' },
  { group: 'Videos',       path: '/api/videos/public' },
  { group: 'Videos',       path: '/api/videos/trending' },
  { group: 'Videos',       path: '/api/videos/home-feed' },
  { group: 'Videos',       path: '/api/videos/todays-selection' },
  { group: 'Videos',       path: '/api/videos/pornstars' },
  { group: 'Videos',       path: '/api/videos/search?q=test' },
  { group: 'TikTok',       path: '/api/videos/tiktok/feed' },
  { group: 'TikTok',       path: '/api/videos/tiktok/ads/list' },
  { group: 'Live',         path: '/api/live' },
  { group: 'Creators',     path: '/api/creators' },
  { group: 'Creators',     path: '/api/creators/top' },
  { group: 'Posts',        path: '/api/posts' },
  { group: 'Payments',     path: '/api/payments/plans' },
  { group: 'Memberships',  path: '/api/memberships' },
  { group: 'Gifts',        path: '/api/gifts' },
  { group: 'Tokens',       path: '/api/tokens/packages' },
  { group: 'Ads',          path: '/api/ads/next' },
  // ── Admin — system ────────────────────────────────────────────────────────
  { group: 'Admin · System',     path: '/api/admin/system/stats',             adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/health',            adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/settings',          adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/env',               adminAuth: true },
  // ── Admin — content ───────────────────────────────────────────────────────
  { group: 'Admin · Content',    path: '/api/admin/content/videos',           adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/lives',            adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/random-sessions',  adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/premium-videos',   adminAuth: true },
  // ── Admin — moderation ────────────────────────────────────────────────────
  { group: 'Admin · Moderation', path: '/api/admin/moderation/reports',       adminAuth: true },
  { group: 'Admin · Moderation', path: '/api/admin/moderation/audit-logs',    adminAuth: true },
  { group: 'Admin · Moderation', path: '/api/admin/moderation/ai-flags',      adminAuth: true },
  // ── Admin — users ─────────────────────────────────────────────────────────
  { group: 'Admin · Users',      path: '/api/admin/users',                    adminAuth: true },
  { group: 'Admin · Users',      path: '/api/admin/creators',                 adminAuth: true },
  { group: 'Admin · Users',      path: '/api/admin/applications',             adminAuth: true },
  // ── Admin — finance ───────────────────────────────────────────────────────
  { group: 'Admin · Finance',    path: '/api/admin/finance/summary',          adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/membership-plans', adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/subscribers',      adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/payments',         adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/payouts',          adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/ads',              adminAuth: true },
];

export async function getRouteLatency(req, res) {
  const port = process.env.PORT || 5043;
  const base = `http://127.0.0.1:${port}`;
  const adminToken = req.headers.authorization || '';

  async function pingRoute(route) {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const headers = route.adminAuth ? { Authorization: adminToken } : {};
      const r = await fetch(`${base}${route.path}`, { signal: ctrl.signal, headers });
      clearTimeout(timer);
      return {
        path: route.path,
        group: route.group,
        httpStatus: r.status,
        latencyMs: Date.now() - start,
        ok: r.status < 500,
      };
    } catch (err) {
      const timedOut = err?.name === 'AbortError' || err?.message?.includes('abort');
      return {
        path: route.path,
        group: route.group,
        httpStatus: 0,
        latencyMs: Date.now() - start,
        ok: false,
        error: timedOut ? 'Timeout (>5s)' : (err?.message || 'Failed'),
      };
    }
  }

  const t0 = Date.now();
  const routes = await Promise.all(MONITORED_ROUTES.map(pingRoute));
  return res.json({ routes, totalMs: Date.now() - t0, timestamp: new Date().toISOString() });
}

// ── PUT /api/admin/system/admin-users/:id/toggle ──────────────────────────────

export async function toggleAdminUser(req, res) {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (id === req.admin?.id) {
      return res.status(400).json({ message: 'Cannot deactivate your own account.' });
    }

    const { error } = await supabase.from('admin_users').update({ is_active }).eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    await logAction(req.admin?.id, req.admin?.name, `Admin ${is_active ? 'activated' : 'deactivated'}`, 'admin_user', id, { is_active });
    return res.json({ message: `Admin ${is_active ? 'activated' : 'deactivated'} successfully.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}
