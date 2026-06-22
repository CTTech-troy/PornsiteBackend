import { supabase } from '../config/supabase.js';
import { getFirebaseDb, getFirebaseRtdb } from '../config/firebase.js';
import { pingServices } from '../utils/servicePing.js';
import { countCreatorApplicationsByStatus, getUserDirectoryAggregateStats, safeCount } from '../services/userDirectoryService.js';
import {
  getAdminSettingsPayload,
  getResolvedVastSettings,
  getPublicPlatformSettings,
  PLATFORM_SETTINGS_CATALOG,
  saveAdminSettings,
  invalidatePlatformSettingsCache,
} from '../services/platformSettings.service.js';
import { probeVastTag } from '../services/adHealthScanner.service.js';
import { logAction as writeAuditAction } from '../services/adminAudit.service.js';
import { listPlatformActivityEvents } from '../services/platformActivity.service.js';
import { isMeilisearchConfigured, getMeilisearchClient } from '../config/meilisearch.js';

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' ||
    (typeof err?.message === 'string' && err.message.includes('schema cache'));
}

async function logAction(adminId, adminName, action, targetType, targetId, details = {}) {
  await writeAuditAction(adminId, adminName, action, targetType, targetId, details);
}

function getDefaultPublicPlatformSettings() {
  return Object.fromEntries(
    PLATFORM_SETTINGS_CATALOG
      .filter((def) => def.public && !def.sensitive)
      .map((def) => [def.key, String(def.defaultValue ?? '')]),
  );
}

// ── GET /api/admin/system/settings ────────────────────────────────────────────

export async function getSettings(req, res) {
  try {
    const payload = await getAdminSettingsPayload();
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getPublicSettings(req, res) {
  try {
    const settings = await getPublicPlatformSettings();
    return res.json({ success: true, settings });
  } catch (err) {
    console.warn('[config.public:fallback]', {
      requestId: req.requestId,
      message: err?.message || String(err),
    });
    res.set('X-API-Fallback', 'config-public');
    return res.status(200).json({
      success: false,
      settings: getDefaultPublicPlatformSettings(),
      recoverable: true,
      requestId: req.requestId,
      message: 'Public settings fallback loaded.',
    });
  }
}

// ── PUT /api/admin/system/settings ────────────────────────────────────────────

export async function getPublicVastSettings(req, res) {
  try {
    const settings = await getResolvedVastSettings();
    return res.json({
      enabled: settings.enabled,
      provider: settings.provider,
      url: settings.url,
    });
  } catch (err) {
    console.warn('[settings.vast:fallback]', {
      requestId: req.requestId,
      message: err?.message || String(err),
    });
    return res.status(200).json({
      enabled: true,
      provider: 'monetag',
      url: 'https://s.magsrv.com/v1/vast.php?idz=5932212',
      recoverable: true,
    });
  }
}

export async function testVastTag(req, res) {
  try {
    const url = String(req.body?.url || req.body?.tagUrl || '').trim();
    if (!url) return res.status(400).json({ ok: false, message: 'VAST URL required.' });
    const result = await probeVastTag(url, Math.min(5000, Number(req.body?.timeoutMs) || 5000));
    const valid = result.status === 'healthy';
    return res.json({
      ok: valid,
      valid,
      status: result.status,
      responseMs: result.responseMs || 0,
      message: valid ? 'VAST is valid - Ad found' : 'VAST is empty - No ad available right now',
      errorCode: result.errorCode || null,
      errorMessage: result.errorMessage || null,
      diagnostics: result.diagnostics || null,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      valid: false,
      status: 'failed',
      message: 'VAST is empty - No ad available right now',
      errorMessage: err?.message || 'VAST probe failed',
    });
  }
}

export async function updateSettings(req, res) {
  try {
    const { settings } = req.body; // [{ key, value }]
    const result = await saveAdminSettings(settings, req.admin?.name || 'Admin');

    await logAction(req.admin?.id, req.admin?.name, 'Settings updated', 'settings', 'platform', {
      keys: result.updatedKeys,
    });
    return res.json({ message: 'Settings saved successfully.', updatedKeys: result.updatedKeys });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message, errors: err.errors || undefined });
  }
}

// ── PUT /api/admin/system/settings/:key ───────────────────────────────────────

export async function updateSetting(req, res) {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ message: 'value required.' });

    await saveAdminSettings([{ key, value }], req.admin?.name || 'Admin');
    invalidatePlatformSettingsCache();

    await logAction(req.admin?.id, req.admin?.name, `Setting updated: ${key}`, 'settings', key, { value: '[updated]' });
    return res.json({ message: 'Setting updated successfully.' });
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message, errors: err.errors || undefined });
  }
}

// ── GET /api/admin/system/health ──────────────────────────────────────────────

export async function getSystemHealth(req, res) {
  try {
    const { firebase, supabase: supabaseStatus } = await pingServices();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const apiMetrics = req.app?.get('apiMetrics')?.snapshot?.() || null;

    // Count active lives
    let activeLives = 0;
    try {
      const { count } = await supabase.from('lives').select('*', { count: 'exact', head: true }).eq('status', 'live');
      activeLives = count || 0;
    } catch (_) {}

    let totalUsers = 0;
    let userSourceCounts = null;
    try {
      const u = await getUserDirectoryAggregateStats();
      totalUsers = u.mergedTotal || u.totalUsers;
      userSourceCounts = u.sourceCounts || null;
    } catch (_) {}

    let coinWallets = 0;
    try {
      const { count } = await supabase.from('coin_wallets').select('*', { count: 'exact', head: true });
      coinWallets = count || 0;
    } catch (_) {}

    // Count pending payouts
    let pendingPayouts = 0;
    try {
      const { count } = await supabase.from('creator_payout_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending');
      pendingPayouts = count || 0;
    } catch (_) {}

    return res.json({
      services: {
        api_server: {
          status: 'active',
          detail: `Uptime ${Math.floor(process.uptime())}s`,
          active: true,
        },
        database: {
          status: supabaseStatus.status,
          detail: supabaseStatus.detail,
          active: supabaseStatus.status === 'active',
        },
        supabase: {
          status: supabaseStatus.status,
          detail: supabaseStatus.detail,
          active: supabaseStatus.status === 'active',
        },
        authentication: {
          status: firebase.status === 'active' ? 'active' : 'degraded',
          detail: firebase.detail,
          active: firebase.status === 'active',
        },
        firebase: {
          status: firebase.status,
          detail: firebase.detail,
          active: firebase.status === 'active',
        },
        paystack: {
          status: process.env.PAYSTACK_SECRET_KEY ? 'configured' : 'missing',
          detail: process.env.PAYSTACK_SECRET_KEY ? 'Paystack secret is configured.' : 'Paystack secret is missing.',
          active: !!process.env.PAYSTACK_SECRET_KEY,
        },
        email_service: {
          status: process.env.RESEND_API_KEY ? 'configured' : 'missing',
          detail: process.env.RESEND_API_KEY ? 'Email service is configured.' : 'Email service key is missing.',
          active: !!process.env.RESEND_API_KEY,
        },
        uploads_storage: {
          status: process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'missing',
          detail: process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Storage credentials are configured.' : 'Storage credentials are incomplete.',
          active: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
        },
        realtime: {
          status: 'active',
          detail: 'Socket.IO server is attached to the API process.',
          active: true,
        },
      },
      stats: {
        totalUsers,
        userSourceCounts,
        activeLives,
        coinWallets,
        pendingPayouts,
      },
      runtime: {
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
        },
        cpu,
        uptime: Math.floor(process.uptime()),
      },
      apiMetrics,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/env ─────────────────────────────────────────────────

export async function getEnvOverview(req, res) {
  try {
    const envStatus = (key, sensitive = false) => ({
      key,
      value: process.env[key] ? (sensitive ? 'Set (hidden)' : 'Configured') : 'Missing',
      sensitive,
    });
    return res.json({
      env: [
        { key: 'NODE_ENV', value: process.env.NODE_ENV === 'production' ? 'production' : 'non-production', sensitive: false },
        { key: 'PORT', value: process.env.PORT ? 'Configured' : 'Default', sensitive: false },
        envStatus('SUPABASE_URL'),
        envStatus('SUPABASE_SERVICE_ROLE_KEY', true),
        envStatus('FIREBASE_DATABASE_URL'),
        envStatus('GOOGLE_APPLICATION_CREDENTIALS', true),
        envStatus('ADMIN_JWT_SECRET', true),
        envStatus('LIVEKIT_API_KEY', true),
        envStatus('LIVEKIT_API_SECRET', true),
        envStatus('CORS_ORIGINS'),
        envStatus('PAYSTACK_SECRET_KEY', true),
        envStatus('RESEND_API_KEY', true),
        envStatus('FLUTTERWAVE_SECRET_KEY', true),
        envStatus('RAPIDAPI_VIDEO_KEY', true),
      ],
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
    let { data, error } = await supabase
      .from('admin_users')
      .select('id, name, email, role, permissions, is_active, is_super_admin, created_at, last_login, last_active_at, avatar_url')
      .order('created_at', { ascending: false });

    if (error && (error.code === '42703' || error.code === 'PGRST204' || String(error.message || '').includes('schema cache'))) {
      const fallback = await supabase
        .from('admin_users')
        .select('id, name, email, permissions, is_active, is_super_admin, created_at, last_login')
        .order('created_at', { ascending: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (isMissingTable(error)) return res.json({ admins: [] });
      return res.status(500).json({ message: error.message });
    }

    const now = Date.now();
    const admins = (data || []).map((admin) => {
      const lastActiveMs = admin.last_active_at ? new Date(admin.last_active_at).getTime() : 0;
      const online = Number.isFinite(lastActiveMs) && now - lastActiveMs < 5 * 60 * 1000;
      return {
        ...admin,
        name: admin.name || admin.email,
        role: admin.is_super_admin ? 'super_admin' : (admin.role || 'admin'),
        permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
        online,
        account_status: admin.is_active ? 'active' : 'suspended',
        last_active_at: admin.last_active_at || admin.last_login || null,
      };
    });

    return res.json({ admins, users: admins });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ── GET /api/admin/system/stats ───────────────────────────────────────────────

export async function getStats(req, res) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const userDir = await getUserDirectoryAggregateStats(todayStart);

    const [
      pendingApps,
      totalVideos, liveNow, coinWallets, coinTransactions, activeAdCampaigns,
    ] = await Promise.all([
      countCreatorApplicationsByStatus('pending'),
      safeCount(supabase.from('tiktok_videos').select('video_id', { count: 'exact', head: true })),
      safeCount(supabase.from('lives').select('id', { count: 'exact', head: true }).eq('status', 'live')),
      safeCount(supabase.from('coin_wallets').select('id', { count: 'exact', head: true })),
      safeCount(supabase.from('coin_wallet_transactions').select('id', { count: 'exact', head: true })),
      safeCount(supabase.from('ad_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'active')),
    ]);

    const activeUsers = Math.max(
      0,
      userDir.totalUsers - userDir.suspendedUsers - userDir.bannedUsers
    );

    return res.json({
      users: {
        total: userDir.totalUsers,
        totalIncludingFirebase: userDir.totalUsers,
        firebaseOnly: userDir.firebaseOnlyUsers || 0,
        verified: userDir.emailVerifiedUsers,
        active: activeUsers,
        newToday: userDir.newToday,
        suspended: userDir.suspendedUsers,
        banned: userDir.bannedUsers,
        sourceCounts: userDir.sourceCounts || null,
      },
      creators: {
        total: userDir.creatorsTotal,
        pstars: userDir.creatorsPstar,
        channels: userDir.creatorsChannel,
        pendingApplications: pendingApps,
      },
      content:     { videos: totalVideos, liveNow },
      coins:       { wallets: coinWallets, transactions: coinTransactions },
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
    ping('Flutterwave', async () => {
      if (!process.env.FLUTTERWAVE_SECRET_KEY) throw new Error('Not configured');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      try {
        const r = await fetch('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=health-check-probe', {
          headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
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
    ping('Meilisearch', async () => {
      if (!isMeilisearchConfigured()) throw new Error('Not configured');
      const client = getMeilisearchClient();
      const health = await client.health();
      if (!health?.status || health.status === 'error') throw new Error('Unhealthy');
    }),
    ping('Import queue', async () => {
      const { count, error } = await supabase
        .from('video_import_jobs')
        .select('*', { count: 'exact', head: true })
        .in('status', ['queued', 'extracting', 'processing']);
      if (error && !isMissingTable(error)) throw error;
      return count;
    }),
  ]);

  return res.json({ apis: checks, totalMs: Date.now() - t0, timestamp: new Date().toISOString() });
}

export async function getPlatformActivity(req, res) {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const data = await listPlatformActivityEvents({ limit, offset });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, data: [], message: err?.message || 'Failed' });
  }
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
  { group: 'Posts',        path: '/api/videos/posts' },
  { group: 'Coins',        path: '/api/coins/packages' },
  { group: 'Gifts',        path: '/api/gifts' },
  { group: 'Tokens',       path: '/api/tokens/packages' },
  { group: 'Ads',          path: '/api/ads/next' },
  // ── Admin — system ────────────────────────────────────────────────────────
  { group: 'Admin · System',     path: '/api/admin/system/stats',             adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/health',            adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/settings',          adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/env',               adminAuth: true },
  { group: 'Admin · System',     path: '/api/admin/system/email-templates',   adminAuth: true },
  // ── Admin — content ───────────────────────────────────────────────────────
  { group: 'Admin · Content',    path: '/api/admin/content/videos',           adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/imported-videos',  adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/lives',            adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/random-sessions',  adminAuth: true },
  { group: 'Admin · Content',    path: '/api/admin/content/premium-videos',   adminAuth: true },
  // ── Admin — moderation ────────────────────────────────────────────────────
  { group: 'Admin · Moderation', path: '/api/admin/moderation/audit-logs',    adminAuth: true },
  { group: 'Admin · Moderation', path: '/api/admin/moderation/ai-flags',      adminAuth: true },
  // ── Admin — users ─────────────────────────────────────────────────────────
  { group: 'Admin · Users',      path: '/api/admin/users',                    adminAuth: true },
  { group: 'Admin · Users',      path: '/api/admin/creators',                 adminAuth: true },
  { group: 'Admin · Users',      path: '/api/admin/applications',             adminAuth: true },
  // ── Admin — finance ───────────────────────────────────────────────────────
  { group: 'Admin · Finance',    path: '/api/admin/finance/summary',          adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/payment-history',  adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/payouts',          adminAuth: true },
  { group: 'Admin · Finance',    path: '/api/admin/finance/ads',              adminAuth: true },
];

export async function getRouteLatency(req, res) {
  const base = String(
    process.env.BACKEND_PUBLIC_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    'https://api.xstreamvideos.site',
  ).replace(/\/$/, '');
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
