import './src/config/env.js';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import authRouter from './src/router/auth.route.js';
import keepAliveRouter from './src/router/keepAlive.route.js';
import apiMonitoringWorkflowRouter from './src/router/apiMonitoringWorkflow.route.js';
import payoutWorkflowRouter from './src/router/payoutWorkflow.route.js';
import aiModerationWorkflowRouter from './src/router/aiModerationWorkflow.route.js';
import monetizationWorkflowRouter from './src/router/monetizationWorkflow.route.js';
import enterpriseImportWorkflowRouter from './src/router/enterpriseImportWorkflow.route.js';
import videosRouter from './src/router/videos.route.js';
import postsRouter from './src/router/posts.route.js';
import * as streamCtrl from './src/controller/stream.controller.js';
import liveRouter from './src/router/live.route.js';
import giftRouter from './src/router/gift.route.js';
import usersRouter from './src/router/users.route.js';
import creatorsRouter from './src/router/creators.route.js';
import contentRemovalRouter from './src/router/ContentRemoval.route.js';
import paymentRouter from './src/router/payment.route.js';
import tokensRouter  from './src/router/tokens.route.js';
import coinsRouter from './src/router/coins.route.js';
import messagesRouter from './src/router/messages.route.js';
import earningsRouter from './src/router/earnings.route.js';
import adminRouter from './src/router/admin.route.js';
import adsRouter from './src/router/ads.route.js';
import financeRouter from './src/router/finance.route.js';
import creatorStudioRouter from './src/router/creatorStudio.route.js';
import adminContentRouter from './src/router/adminContent.route.js';
import adminModerationRouter from './src/router/adminModeration.route.js';
import adminSystemRouter from './src/router/adminSystem.route.js';
import adminAnalyticsRouter from './src/router/adminAnalytics.route.js';
import adsAnalyticsRouter from './src/router/adsAnalytics.route.js';
import adminCoinsRouter from './src/router/adminCoins.route.js';
import analyticsRouter from './src/router/analytics.route.js';
import promotionsRouter from './src/router/promotions.route.js';
import adminPromotionsRouter from './src/router/adminPromotions.route.js';
import adminStorageMonitoringRouter from './src/router/adminStorageMonitoring.route.js';
import creatorsMainApplicationRouter from './src/router/creatorsMainApplication.route.js';
import legalRouter from './src/router/legal.route.js';
import blogRouter from './src/router/blog.route.js';
import { getPublicSettings, getPublicVastSettings } from './src/controller/adminSystem.controller.js';
import * as liveCtrl from './src/controller/live.controller.js';
import { creditLiveEarnings } from './src/controller/earnings.controller.js';
import * as walletsystem from './src/controller/walletsystem.controller.js';
import * as chatQueue from './src/controller/chatQueue.controller.js';
import * as randomChatBilling from './src/services/randomChatBilling.service.js';
import { sendCreatorGift } from './src/services/coinWallet.service.js';
import { bindChatRoomRegistry } from './src/services/chatRoomRegistry.service.js';
import { supabase, ensureBuckets } from './src/config/supabase.js';
import { syncCacheToSupabase } from './src/config/live-cache.js';
import { syncRtdbToSupabase } from './src/config/dbFallback.js';
import { printFirebaseStartupSummary } from './src/config/firebase.js';
import { pingServices } from './src/utils/servicePing.js';
import { pingPaymentService, STARTUP_HEALTH_TIMEOUT_MS } from './src/services/paymentServiceClient.js';
import { resolveUidFromBearerToken } from './src/utils/sessionToken.js';
import { getAuthMetricsSnapshot } from './src/utils/authMetrics.js';
import adProvidersRouter from './src/router/adProviders.route.js';
import partnerRouter from './src/router/partner.route.js';
import publisherRouter from './src/router/publisher.route.js';
import adminPartnersRouter from './src/router/adminPartners.route.js';
import publisherWorkflowRouter from './src/router/publisherWorkflow.route.js';
import videoImportWorkflowRouter from './src/router/videoImportWorkflow.route.js';
import { startHealthScanScheduler } from './src/services/adHealthScanner.service.js';
import { renderVideoSharePreview } from './src/controller/sharePreview.controller.js';
import { renderSitemapIndex, renderVideoSitemap } from './src/controller/seoSitemap.controller.js';
import { preloadExternalFeedConfig } from './src/services/externalFeedConfig.service.js';
import { startSearchSyncScheduler } from './src/services/searchIndex.service.js';
import { generalApiRateLimiter } from './src/middleware/apiRateLimit.js';
import { getRateLimitStoreDiagnostics } from './src/middleware/rateLimitStore.js';
import { apiMonitoringMiddleware } from './src/middleware/apiMonitoring.js';
import { getRedisDiagnostics, getRedisHealth, pingRedis } from './src/config/redis.js';
import { getQstashStatus } from './src/config/qstash.js';
import {
  assertEnterpriseImportQueueReady,
  getEnterpriseImportQueueHealth,
  reconcileEnterpriseImportQueue,
} from './src/services/enterpriseImportQueue.service.js';
import {
  getEnterpriseImportWorkerRuntimeStatus,
  startEnterpriseImportWorker,
} from './src/services/enterpriseImportWorker.service.js';
import {
  getR2ImportStorageStatus,
  validateR2ImportBucket,
} from './src/services/r2ImportStorage.service.js';
import { startStorageReplicationWorker } from './src/services/mediaRedundancy.service.js';
import { getLocalMemoryCacheDiagnostics } from './src/services/localMemoryCache.service.js';
import { resolveAdminSessionFromToken } from './src/middleware/adminAuth.js';
import { getApiOverview } from './src/services/apiMonitoring.service.js';
import {
  endAiSession,
  ensureAiSession,
  getAiModerationOverview,
  recordModerationSignal,
} from './src/services/aiModeration.service.js';
import {
  getMemoryDiagnostics,
  logMemoryUsage,
  startMemoryDiagnostics,
} from './src/utils/memoryDiagnostics.js';

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

const LIVEKIT_HTTP_ORIGIN = 'https://xstream-8lx5fseo.livekit.cloud';
const LIVEKIT_WS_ORIGIN = 'wss://xstream-8lx5fseo.livekit.cloud';
const SOCKET_IO_HTTP_ORIGIN = 'https://api.xstreamvideos.site';
const SOCKET_IO_WS_ORIGIN = 'wss://api.xstreamvideos.site';
const PERMISSIONS_POLICY_HEADER = [
  'accelerometer=()',
  'autoplay=*',
  'bluetooth=()',
  'browsing-topics=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=*',
  'fullscreen=*',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=(self)',
  'picture-in-picture=*',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

const TRUSTED_VIDEO_EMBED_SOURCES = [
  'https://www.xvideos.com',
  'https://xvideos.com',
  'https://*.xvideos.com',
  'https://xhamster.com',
  'https://www.xhamster.com',
  'https://*.xhamster.com',
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.dailymotion.com',
  'https://videos.com',
  'https://www.videos.com',
  'https://*.videos.com',
  'https://xnxx.com',
  'https://www.xnxx.com',
  'https://*.xnxx.com',
  'https://redtube.com',
  'https://www.redtube.com',
  'https://*.redtube.com',
  'https://youporn.com',
  'https://www.youporn.com',
  'https://*.youporn.com',
  'https://spankbang.com',
  'https://www.spankbang.com',
  'https://*.spankbang.com',
  'https://eporner.com',
  'https://www.eporner.com',
  'https://*.eporner.com',
  'https://tube8.com',
  'https://www.tube8.com',
  'https://*.tube8.com',
];

const TRUSTED_AD_FRAME_SOURCES = [
  'https://imasdk.googleapis.com',
  'https://*.google.com',
  'https://s.magsrv.com',
  'https://*.magsrv.com',
  'https://vast.yomeno.xyz',
  'https://*.yomeno.xyz',
  'https://juicyads.com',
  'https://www.juicyads.com',
  'https://js.juicyads.com',
  'https://poweredby.jads.co',
  'https://*.jads.co',
  'https://a.adtng.com',
  'https://*.adtng.com',
  'https://quge5.com',
  'https://monetag.com',
  'https://www.monetag.com',
  'https://*.monetag.com',
  'https://*.highperformanceformat.com',
  'https://*.profitablecpmrate.com',
  'https://*.profitablecpmgate.com',
  'https://*.alwingulla.com',
  'https://5gvci.com',
  'https://securepubads.g.doubleclick.net',
  'https://*.doubleclick.net',
  'https://*.googlesyndication.com',
];

const TRUSTED_FRAME_SOURCES = [
  LIVEKIT_HTTP_ORIGIN,
  ...TRUSTED_VIDEO_EMBED_SOURCES,
  ...TRUSTED_AD_FRAME_SOURCES,
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://xstreamvideos.site',
  'https://www.xstreamvideos.site',
  'https://admin.xstreamvideos.site',
];

const DEVELOPMENT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'http://127.0.0.1:5176',
];

const CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = [
  'Accept',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'DNT',
  'If-Modified-Since',
  'Keep-Alive',
  'Last-Event-ID',
  'Origin',
  'Pragma',
  'User-Agent',
  'X-Admin-Token',
  'X-API-Key',
  'X-Requested-With',
  'X-Request-Id',
];
const CORS_EXPOSED_HEADERS = [
  'Content-Length',
  'Content-Range',
  'X-Request-Id',
];
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 86400;

function isDeveloperMode() {
  const env = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  return ['development', 'dev', 'local', 'test'].includes(env);
}

function isEnabledEnvFlag(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function isRenderRuntime() {
  return Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
}

function shouldAllowLocalhostCors() {
  return isEnabledEnvFlag(process.env.ALLOW_LOCALHOST_CORS, true);
}

function isLocalhostOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseAllowedOrigins(rawOrigins) {
  const envList = typeof rawOrigins === 'string' && rawOrigins.trim() ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const devList = (isDeveloperMode() || shouldAllowLocalhostCors()) ? DEVELOPMENT_ALLOWED_ORIGINS : [];
  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...devList, ...envList]));
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGINS);
const allowedOriginsSet = new Set(ALLOWED_ORIGINS);
console.info('[cors] Allowed origins configured', {
  mode: isDeveloperMode() ? 'development' : 'production',
  localhostCors: shouldAllowLocalhostCors() ? 'enabled' : 'disabled',
  origins: ALLOWED_ORIGINS,
});

function isOriginAllowed(origin) {
  return !origin
    || allowedOriginsSet.has(origin)
    || (shouldAllowLocalhostCors() && isLocalhostOrigin(origin));
}

function buildCorsError(origin) {
  const error = new Error(`Not allowed by CORS for origin: ${origin}`);
  error.status = 403;
  error.statusCode = 403;
  error.code = 'CORS_ORIGIN_DENIED';
  return error;
}

function corsOriginDelegate(origin, callback) {
  if (isOriginAllowed(origin)) return callback(null, true);
  return callback(buildCorsError(origin));
}

function appendVary(res, value) {
  const existing = String(res.getHeader('Vary') || '');
  const values = new Set(existing.split(',').map((part) => part.trim()).filter(Boolean));
  for (const part of String(value || '').split(',')) {
    const trimmed = part.trim();
    if (trimmed) values.add(trimmed);
  }
  if (values.size) res.setHeader('Vary', Array.from(values).join(', '));
}

function requestedCorsHeaders(req) {
  const requested = String(req.headers['access-control-request-headers'] || '').trim();
  return requested || CORS_ALLOWED_HEADERS.join(', ');
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  appendVary(res, 'Origin, Access-Control-Request-Headers');
  if (!isOriginAllowed(origin)) return false;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', CORS_METHODS.join(','));
  res.setHeader('Access-Control-Allow-Headers', requestedCorsHeaders(req));
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS.join(','));
  res.setHeader('Access-Control-Max-Age', String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
  return true;
}

const corsOptions = {
  origin: corsOriginDelegate,
  credentials: true,
  methods: CORS_METHODS,
  allowedHeaders: CORS_ALLOWED_HEADERS,
  exposedHeaders: CORS_EXPOSED_HEADERS,
  maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  const allowed = applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).json({ success: false, message: 'CORS origin denied' });
    return res.status(204).end();
  }
  return next();
});
 
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        SOCKET_IO_HTTP_ORIGIN,
        SOCKET_IO_WS_ORIGIN,
        'https://payments.xstreamvideos.site',
        'https://xstreamvideos.site',
        'https://admin.xstreamvideos.site',
        'https://*.supabase.co',
        LIVEKIT_HTTP_ORIGIN,
        LIVEKIT_WS_ORIGIN,
        ...TRUSTED_VIDEO_EMBED_SOURCES,
        'https://imasdk.googleapis.com',
        'https://s.magsrv.com',
        'https://*.magsrv.com',
        'https://vast.yomeno.xyz',
        'https://*.yomeno.xyz',
        'https://googleads.g.doubleclick.net',
        'https://securepubads.g.doubleclick.net',
        'https://pagead2.googlesyndication.com',
        'https://pubads.g.doubleclick.net',
        'https://cloudflareinsights.com',
        'https://static.cloudflareinsights.com',
      ],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:', LIVEKIT_HTTP_ORIGIN],
      mediaSrc: ["'self'", 'blob:', 'https:', LIVEKIT_HTTP_ORIGIN, ...TRUSTED_VIDEO_EMBED_SOURCES],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://imasdk.googleapis.com',
        'https://s.magsrv.com',
        'https://*.magsrv.com',
        'https://vast.yomeno.xyz',
        'https://*.yomeno.xyz',
        'https://poweredby.jads.co',
        'https://*.jads.co',
        'https://quge5.com',
        'https://monetag.com',
        'https://*.monetag.com',
        'https://*.highperformanceformat.com',
        'https://*.profitablecpmrate.com',
        'https://*.profitablecpmgate.com',
        'https://*.alwingulla.com',
        'https://5gvci.com',
        'https://securepubads.g.doubleclick.net',
        'https://*.googlesyndication.com',
        'https://static.cloudflareinsights.com',
      ],
      childSrc: ["'self'", ...TRUSTED_FRAME_SOURCES],
      frameSrc: ["'self'", ...TRUSTED_FRAME_SOURCES],
      workerSrc: ["'self'", 'blob:', LIVEKIT_HTTP_ORIGIN],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(compression());

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = String(requestId);
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY_HEADER);
  next();
});

app.use(cors(corsOptions));

// QStash signs the exact request body. Capture keep-alive requests as raw bytes
// before the global JSON parser so verification works for dashboard-created
// schedules as well as the SDK-created JSON schedule.
app.use('/api/keepalive', express.raw({ type: '*/*', limit: '16kb' }));
app.use('/api/internal/qstash/monitoring', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/payouts', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/ai-moderation', express.raw({ type: '*/*', limit: '128kb' }));
app.use('/api/internal/qstash/monetization', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/publisher', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/internal/qstash/enterprise-import', express.raw({ type: '*/*', limit: '64kb' }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(apiMonitoringMiddleware);

const apiMetrics = {
  startedAt: new Date().toISOString(),
  total: 0,
  success: 0,
  failure: 0,
  totalLatencyMs: 0,
  routes: new Map(),
  snapshot() {
    const routes = Array.from(this.routes.entries()).map(([path, stats]) => ({
      path,
      count: stats.count,
      success: stats.success,
      failure: stats.failure,
      avgLatencyMs: stats.count ? Math.round(stats.totalLatencyMs / stats.count) : 0,
      maxLatencyMs: stats.maxLatencyMs,
      lastStatus: stats.lastStatus,
      lastSeenAt: stats.lastSeenAt,
    })).sort((a, b) => b.avgLatencyMs - a.avgLatencyMs).slice(0, 25);
    return {
      startedAt: this.startedAt,
      total: this.total,
      success: this.success,
      failure: this.failure,
      avgLatencyMs: this.total ? Math.round(this.totalLatencyMs / this.total) : 0,
      routes,
    };
  },
};

app.set('apiMetrics', apiMetrics);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const latency = Date.now() - started;
    const key = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    const stats = apiMetrics.routes.get(key) || {
      count: 0,
      success: 0,
      failure: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      lastStatus: 0,
      lastSeenAt: null,
    };
    stats.count += 1;
    stats.totalLatencyMs += latency;
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latency);
    stats.lastStatus = res.statusCode;
    stats.lastSeenAt = new Date().toISOString();
    if (res.statusCode >= 500) stats.failure += 1;
    else stats.success += 1;
    apiMetrics.total += 1;
    apiMetrics.totalLatencyMs += latency;
    if (res.statusCode >= 500) apiMetrics.failure += 1;
    else apiMetrics.success += 1;
    apiMetrics.routes.set(key, stats);
  });
  next();
});

console.log(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);

app.get('/', (req, res) => {
  res.send(`API running on port ${PORT}`);
});

app.get('/api/health/services', async (req, res) => {
  try {
    const { firebase, supabase } = await pingServices();
    res.json({ firebase, supabase, redis: getRedisHealth(), qstash: getQstashStatus(), r2Import: getR2ImportStorageStatus() });
  } catch (err) { res.status(500).json({ error: err?.message || String(err) }); }
});

app.get('/api/health/redis', async (req, res) => {
  const redis = await pingRedis();
  res.status(redis.configured && !redis.connected ? 503 : 200).json({
    redis,
    diagnostics: getRedisDiagnostics(),
    rateLimits: getRateLimitStoreDiagnostics(),
    memoryCache: getLocalMemoryCacheDiagnostics(),
    apiHotspots: apiMetrics.snapshot().routes,
  });
});

app.get('/api/health/memory', (_req, res) => {
  res.json({ success: true, memory: getMemoryDiagnostics() });
});

app.get('/api/health/import-queue', async (_req, res) => {
  const health = await getEnterpriseImportQueueHealth();
  res.status(health.redis.configured && !health.redis.connected ? 503 : 200).json({ success: true, health });
});

app.get('/api/health/import-worker', (_req, res) => {
  res.json({ success: true, worker: getEnterpriseImportWorkerRuntimeStatus() });
});

app.get('/api/config/public', getPublicSettings);
app.get('/api/settings/vast', getPublicVastSettings);
app.get('/share/video/:id', renderVideoSharePreview);
app.get('/api/share/video/:id', renderVideoSharePreview);
app.get(['/sitemap-index.xml', '/api/sitemap-index.xml'], renderSitemapIndex);
app.get(['/sitemap-videos.xml', '/api/sitemap-videos.xml', '/api/seo/sitemap-videos.xml'], renderVideoSitemap);

app.use('/api/keepalive', keepAliveRouter);
app.use('/api/internal/qstash/monitoring', apiMonitoringWorkflowRouter);
app.use('/api/internal/qstash/payouts', payoutWorkflowRouter);
app.use('/api/internal/qstash/ai-moderation', aiModerationWorkflowRouter);
app.use('/api/internal/qstash/monetization', monetizationWorkflowRouter);
app.use('/api/internal/qstash/publisher', publisherWorkflowRouter);
app.use('/api/internal/qstash/video-import', videoImportWorkflowRouter);
app.use('/api/internal/qstash/enterprise-import', enterpriseImportWorkflowRouter);

// Shared Upstash Redis-backed limit for all API routes. Auth routes below add
// stricter endpoint-specific limits on top of this baseline.
app.use('/api', generalApiRateLimiter);

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/finance', financeRouter);
app.use('/api/admin/content', adminContentRouter);
app.use('/api/admin/moderation', adminModerationRouter);
app.use('/api/admin/system', adminSystemRouter);
app.use('/api/admin/analytics', adminAnalyticsRouter);
app.use('/api/admin/ads-management', adsAnalyticsRouter);
app.use('/api/admin/coins', adminCoinsRouter);
app.use('/api/admin/promotions', adminPromotionsRouter);
app.use('/api/admin/storage', adminStorageMonitoringRouter);
app.use('/api/admin/creators-main-application', creatorsMainApplicationRouter);
app.get('/api/videos/stream/:id', (req, res) => streamCtrl.getStreamUrl(req, res));
// Videos proxy routes
app.use('/api/videos', videosRouter);
app.use('/api/posts', postsRouter);
app.use('/api/live', liveRouter);
app.use('/api/gifts', giftRouter);
app.use('/api/users', usersRouter);
app.use('/api/creators', creatorsRouter);
app.use('/api/creator', creatorsRouter);
app.use('/api/contentRemoval', contentRemovalRouter);
app.use('/api/content-removal', contentRemovalRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/coins', coinsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/earnings', earningsRouter);
app.use('/api/studio', creatorStudioRouter);
app.use('/api/ads', adsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/promotions', promotionsRouter);
app.use('/api/legal', legalRouter);
app.use('/api/blog', blogRouter);
console.info('[startup] Mounting ad provider routes at /api/ad-providers', {
  routes: [
    'GET /api/ad-providers/config',
    'GET /api/ad-providers/safe-policy',
    'GET /api/ad-providers/slots/config',
    'POST /api/ad-providers/monitoring/events',
  ],
});
app.use('/api/ad-providers', adProvidersRouter);
app.use('/api/partner', partnerRouter);
app.use('/api/publisher', publisherRouter);
app.use('/api/admin/partners', adminPartnersRouter);
// Creators Main Application
app.use('/api/creators-main-application', creatorsMainApplicationRouter);

app.use('/api', (req, res) => {
  const message = `API route not found: ${req.method} ${req.originalUrl}`;
  res.status(404).json({
    success: false,
    message,
    requestId: req.requestId,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message,
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    },
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err?.status || err?.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const isProduction = process.env.NODE_ENV === 'production';
  const publicMessage = isProduction && safeStatus >= 500 ? 'Internal server error' : (err?.message || 'Request failed');
  const code = err?.code || (safeStatus >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED');
  console.error('[request:error]', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status: safeStatus,
    message: err?.message || String(err),
    code,
    stack: isProduction ? undefined : err?.stack,
  });
  res.status(safeStatus).json({
    success: false,
    message: publicMessage,
    requestId: req.requestId,
    error: {
      code,
      message: publicMessage,
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
      ...(isProduction ? {} : { details: err?.message || String(err) }),
    },
  });
});

const PORT = process.env.PORT || 5043;
import http from 'http';
const server = http.createServer(app);
import { Server } from 'socket.io';
const io = new Server(server, { cors: { origin: corsOriginDelegate, methods: ['GET', 'POST'], credentials: true } });
const enterpriseImportWorkerController = new AbortController();
let serverHasListened = false;

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (token) {
      const uid = await resolveUidFromBearerToken(token);
      if (uid) { socket.uid = uid; socket.isGuest = false; return next(); }
    }
    socket.uid = `guest:${socket.id}`; socket.isGuest = true; next();
  } catch (err) { socket.uid = `guest:${socket.id}`; socket.isGuest = true; next(); }
});

app.set('io', io);

const VALID_CHAT_GENDERS = new Set(['male', 'female', 'any']);
const chatQueueEntries = new Map(); // userId -> { userId, socketId, gender, preference, joinedAt }
const chatRooms = new Map(); // roomId -> { roomId, a, b, createdAt }
const userActiveChatRooms = new Map(); // userId -> roomId
const CHAT_READY_TIMEOUT_MS = 45_000;

function normalizeChatGender(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_CHAT_GENDERS.has(v) ? v : 'any';
}

function preferenceAllows(preference, peerGender) {
  return preference === 'any' || preference === peerGender;
}

function usersAreCompatible(a, b) {
  return (
    a.userId !== b.userId &&
    preferenceAllows(a.preference, b.gender) &&
    preferenceAllows(b.preference, a.gender)
  );
}

function publicChatUser(entry) {
  return {
    userId: entry.userId,
    gender: entry.gender,
    preference: entry.preference,
  };
}

function chatBillingPayload(access = {}) {
  return {
    cost: randomChatBilling.RANDOM_CHAT_BILLING_COST,
    intervalMs: randomChatBilling.RANDOM_CHAT_BILLING_INTERVAL_MS,
    lowBalanceThreshold: randomChatBilling.RANDOM_CHAT_LOW_BALANCE,
    balance: Number(access.balance || 0),
  };
}

function emitChatBalance(socket, access = {}) {
  socket.emit('chat:balance', chatBillingPayload(access));
}

function emitChatPaywall(socket, access = {}, message = 'You have run out of coins. Buy coins to continue using Random Chat.') {
  socket.emit('chat:paywall', {
    ...chatBillingPayload(access),
    reason: access.reason || 'INSUFFICIENT_COINS',
    message,
  });
}

async function getSocketChatAccess(socket) {
  const access = await randomChatBilling.getRandomChatAccess(socket.uid);
  emitChatBalance(socket, access);
  if (!access.allowed) {
    emitChatPaywall(socket, access);
    return null;
  }
  return access;
}

function chatPeerUserId(room, userId) {
  if (!room) return null;
  if (room.a.userId === userId) return room.b.userId;
  if (room.b.userId === userId) return room.a.userId;
  return null;
}

function chatRoomSocket(entry) {
  return entry?.socketId ? io.sockets.sockets.get(entry.socketId) : null;
}

function clearChatRoomTimers(room) {
  if (!room) return;
  clearTimeout(room.readyTimeout);
  clearTimeout(room.billingTimer);
  room.readyTimeout = null;
  room.billingTimer = null;
}

async function finalizeChatUsage(room, userEntry, reason = 'ended', status = 'ended') {
  const billing = room?.billingByUser?.get(userEntry.userId);
  if (!billing) return;
  await randomChatBilling.finalizeUsageRecord({
    id: billing.usageId,
    roomId: room.roomId,
    userId: userEntry.userId,
    startedAt: room.createdAt,
    connectedAt: room.connectedAt,
    endedAt: Date.now(),
    coinsSpent: billing.coinsSpent || 0,
    billingEvents: billing.events || [],
    endReason: reason,
    status,
  }).catch(() => {});
}

function emitLowBalance(socket, access = {}) {
  const balance = Number(access.balance || 0);
  if (balance > randomChatBilling.RANDOM_CHAT_LOW_BALANCE) return;
  socket.emit('chat:low-balance', {
    ...chatBillingPayload(access),
    message: `You are running low on coins (${balance.toLocaleString()} left).`,
  });
}

function parseCsvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getRtcIceServers() {
  const stunUrls = parseCsvEnv('WEBRTC_STUN_URLS');
  const turnUrls = parseCsvEnv('WEBRTC_TURN_URLS').concat(parseCsvEnv('TURN_URLS'));
  const iceServers = [
    { urls: stunUrls.length ? stunUrls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.WEBRTC_TURN_USERNAME || process.env.TURN_USERNAME || '',
      credential: process.env.WEBRTC_TURN_CREDENTIAL || process.env.TURN_CREDENTIAL || '',
    });
  }
  return iceServers;
}

function isValidSessionDescription(desc, expectedType) {
  return (
    desc &&
    desc.type === expectedType &&
    typeof desc.sdp === 'string' &&
    desc.sdp.length > 0 &&
    desc.sdp.length < 200_000
  );
}

function isValidIceCandidate(candidate) {
  return (
    candidate &&
    typeof candidate.candidate === 'string' &&
    candidate.candidate.length < 5000
  );
}

function checkSocketRate(socket, key, limit, windowMs) {
  const now = Date.now();
  const store = socket.data.rateLimits || {};
  const hits = (store[key] || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    store[key] = hits;
    socket.data.rateLimits = store;
    return false;
  }
  hits.push(now);
  store[key] = hits;
  socket.data.rateLimits = store;
  return true;
}

function removeQueuedUser(userId) {
  if (!userId) return;
  chatQueueEntries.delete(userId);
  chatQueue.dequeueUser(userId).catch(() => {});
}

function leaveSocketRooms(socket) {
  const roomIds = Array.from(socket.data.chatRoomIds || []);
  for (const roomId of roomIds) {
    endChatRoom(roomId, socket.uid, { notifySelf: false });
  }
  socket.data.chatRoomIds = new Set();
}

async function findCompatiblePeer(requester) {
  const candidates = Array.from(chatQueueEntries.values())
    .filter((candidate) => usersAreCompatible(requester, candidate))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  for (const candidate of candidates) {
    const peerSocket = io.sockets.sockets.get(candidate.socketId);
    if (!peerSocket || !peerSocket.connected) {
      chatQueueEntries.delete(candidate.userId);
      continue;
    }

    const peerAccess = await getSocketChatAccess(peerSocket).catch(() => null);
    if (!peerAccess) {
      chatQueueEntries.delete(candidate.userId);
      chatQueue.dequeueUser(candidate.userId).catch(() => {});
      continue;
    }

    return { peer: candidate, peerAccess };
  }
  return null;
}

async function createChatRoom(requester, peer, requesterAccess, peerAccess) {
  const requesterSocket = io.sockets.sockets.get(requester.socketId);
  const peerSocket = io.sockets.sockets.get(peer.socketId);
  if (!requesterSocket || !peerSocket) return null;

  if (userActiveChatRooms.has(requester.userId)) {
    endChatRoom(userActiveChatRooms.get(requester.userId), requester.userId, { notifySelf: true, reason: 'new-session' });
  }
  if (userActiveChatRooms.has(peer.userId)) {
    endChatRoom(userActiveChatRooms.get(peer.userId), peer.userId, { notifySelf: true, reason: 'new-session' });
  }

  const roomId = randomUUID();
  const room = {
    roomId,
    a: requester,
    b: peer,
    createdAt: Date.now(),
    connectedAt: null,
    ready: new Set(),
    billingByUser: new Map([
      [requester.userId, { access: requesterAccess, intervalIndex: 0, coinsSpent: 0, events: [], usageId: null }],
      [peer.userId, { access: peerAccess, intervalIndex: 0, coinsSpent: 0, events: [], usageId: null }],
    ]),
    billingInFlight: false,
    billingClosed: false,
    readyTimeout: null,
    billingTimer: null,
  };
  chatRooms.set(roomId, room);
  userActiveChatRooms.set(requester.userId, roomId);
  userActiveChatRooms.set(peer.userId, roomId);
  chatQueueEntries.delete(requester.userId);
  chatQueueEntries.delete(peer.userId);

  requesterSocket.join(roomId);
  peerSocket.join(roomId);
  requesterSocket.data.chatRoomIds = requesterSocket.data.chatRoomIds || new Set();
  peerSocket.data.chatRoomIds = peerSocket.data.chatRoomIds || new Set();
  requesterSocket.data.chatRoomIds.add(roomId);
  peerSocket.data.chatRoomIds.add(roomId);
  ensureAiSession({
    sessionId: roomId,
    sessionType: 'ivi',
    title: 'Random 1-on-1 session',
    metadata: {
      participants: [requester.userId, peer.userId],
      hidden: true,
      role: 'system_ai',
    },
    io,
  }).catch((error) => console.warn('[ai-moderation] IVI session init failed:', error?.message || error));
  emitChatBalance(requesterSocket, requesterAccess);
  emitChatBalance(peerSocket, peerAccess);
  emitLowBalance(requesterSocket, requesterAccess);
  emitLowBalance(peerSocket, peerAccess);

  const iceServers = getRtcIceServers();
  requesterSocket.emit('chat:matched', {
    roomId,
    initiator: true,
    peer: publicChatUser(peer),
    iceServers,
    billing: chatBillingPayload(requesterAccess),
  });
  peerSocket.emit('chat:matched', {
    roomId,
    initiator: false,
    peer: publicChatUser(requester),
    iceServers,
    billing: chatBillingPayload(peerAccess),
  });

  for (const [userId, billing] of room.billingByUser.entries()) {
    const peerUserId = chatPeerUserId(room, userId);
    randomChatBilling.createUsageRecord({
      roomId,
      userId,
      peerUserId,
      startedAt: room.createdAt,
      startingBalance: billing.access?.balance || 0,
    }).then((usageId) => {
      const activeRoom = chatRooms.get(roomId);
      activeRoom?.billingByUser?.get(userId) && (activeRoom.billingByUser.get(userId).usageId = usageId);
    }).catch(() => {});
  }

  room.readyTimeout = setTimeout(() => {
    endChatRoom(roomId, null, { notifySelf: true, reason: 'setup-timeout', status: 'failed' });
  }, CHAT_READY_TIMEOUT_MS);
  room.readyTimeout.unref?.();

  return room;
}

function getRoomForSocket(socket, roomId) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room) return null;
  return room.a.userId === socket.uid || room.b.userId === socket.uid ? room : null;
}

function emitToRoomPeer(socket, roomId, event, payload = {}) {
  const room = getRoomForSocket(socket, roomId);
  if (!room) {
    socket.emit('chat:error', { message: 'Chat session is no longer active.' });
    return false;
  }
  socket.to(room.roomId).emit(event, {
    ...payload,
    roomId: room.roomId,
    fromId: socket.uid,
  });
  return true;
}

function scheduleChatBilling(room) {
  if (!room || room.billingClosed || !chatRooms.has(room.roomId)) return;
  clearTimeout(room.billingTimer);
  room.billingTimer = setTimeout(() => {
    chargeChatRoom(room.roomId).catch((err) => {
      console.error('[chat] coin billing interval failed:', err?.message || err);
      const activeRoom = chatRooms.get(room.roomId);
      if (activeRoom) scheduleChatBilling(activeRoom);
    });
  }, randomChatBilling.RANDOM_CHAT_BILLING_INTERVAL_MS);
  room.billingTimer.unref?.();
}

async function chargeChatRoom(roomId) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room || room.billingClosed || !room.connectedAt || room.billingInFlight) return;
  room.billingInFlight = true;

  try {
    for (const user of [room.a, room.b]) {
      const userSocket = chatRoomSocket(user);
      if (!userSocket?.connected) {
        endChatRoom(room.roomId, user.userId, { notifySelf: true, reason: 'socket-disconnected' });
        return;
      }

      const billing = room.billingByUser.get(user.userId);
      billing.intervalIndex += 1;
      let result;
      try {
        result = await randomChatBilling.chargeRandomChatInterval({
          userId: user.userId,
          roomId: room.roomId,
          peerUserId: chatPeerUserId(room, user.userId),
          intervalIndex: billing.intervalIndex,
        });
      } catch (err) {
        err.userId = user.userId;
        throw err;
      }
      const event = {
        ts: new Date().toISOString(),
        intervalIndex: billing.intervalIndex,
        charged: result.charged === true,
        amount: Number(result.amount || 0),
        balance: Number(result.balance || 0),
      };
      billing.events.push(event);
      billing.coinsSpent += event.amount;
      billing.access = { ...billing.access, ...result, balance: event.balance };
      emitChatBalance(userSocket, billing.access);
      emitLowBalance(userSocket, billing.access);
    }
  } catch (err) {
    const exhausted = err?.code === 'INSUFFICIENT_COINS';
    const user = [room.a, room.b].find((entry) => entry.userId === err?.userId) || room.a;
    const userSocket = chatRoomSocket(user);
    if (userSocket) emitChatPaywall(userSocket, { balance: err?.balance || 0, reason: err?.code || 'BILLING_FAILED' });
    endChatRoom(room.roomId, user.userId, {
      notifySelf: true,
      reason: exhausted ? 'coins-exhausted' : 'billing-failed',
      status: exhausted ? 'exhausted' : 'failed',
    });
    return;
  } finally {
    const activeRoom = chatRooms.get(String(roomId || ''));
    if (activeRoom) activeRoom.billingInFlight = false;
  }

  const activeRoom = chatRooms.get(String(roomId || ''));
  if (activeRoom) scheduleChatBilling(activeRoom);
}

function maybeStartChatBilling(room) {
  if (!room || room.connectedAt) return;
  if (!room.ready.has(room.a.userId) || !room.ready.has(room.b.userId)) return;
  room.connectedAt = Date.now();
  clearTimeout(room.readyTimeout);
  room.readyTimeout = null;
  io.to(room.roomId).emit('chat:connected', {
    roomId: room.roomId,
    connectedAt: room.connectedAt,
    billing: chatBillingPayload(room.billingByUser.get(room.a.userId)?.access || {}),
  });
  recordModerationSignal({
    sessionId: room.roomId,
    sessionType: 'ivi',
    eventType: 'session_connected',
    source: 'socket',
    contentType: 'behavior',
    metadata: {
      participants: [room.a.userId, room.b.userId],
      connectedAt: room.connectedAt,
    },
    queueAi: false,
    io,
  }).catch(() => {});
  scheduleChatBilling(room);
}

function endChatRoom(roomId, endedBy, { notifySelf = true, reason = 'ended', status = 'ended' } = {}) {
  const room = chatRooms.get(String(roomId || ''));
  if (!room) return;
  room.billingClosed = true;
  clearChatRoomTimers(room);
  chatRooms.delete(room.roomId);
  chatQueue.endChatRoom(room.roomId).catch(() => {});
  endAiSession({
    sessionId: room.roomId,
    status: status === 'failed' ? 'failed' : 'ended',
    metadata: { reason, endedBy },
    io,
  }).catch((error) => console.warn('[ai-moderation] IVI session end failed:', error?.message || error));

  for (const user of [room.a, room.b]) {
    const peerSocket = io.sockets.sockets.get(user.socketId);
    userActiveChatRooms.delete(user.userId);
    finalizeChatUsage(room, user, reason, status).catch(() => {});
    if (peerSocket) {
      peerSocket.leave(room.roomId);
      if (peerSocket.data.chatRoomIds) peerSocket.data.chatRoomIds.delete(room.roomId);
      if (notifySelf || user.userId !== endedBy) {
        const eventName = endedBy && user.userId !== endedBy ? 'chat:peer-left' : 'chat:ended';
        peerSocket.emit(eventName, {
          roomId: room.roomId,
          reason,
        });
      }
    }
  }
}

bindChatRoomRegistry({
  getActiveRooms() {
    const now = Date.now();
    return Array.from(chatRooms.values()).map((room) => {
      let coinsSpent = 0;
      for (const billing of room.billingByUser?.values() || []) {
        coinsSpent += Number(billing.coinsSpent || 0);
      }
      return {
        id: room.roomId,
        user1_id: room.a.userId,
        user2_id: room.b.userId,
        status: 'active',
        created_at: new Date(room.createdAt).toISOString(),
        connected_at: room.connectedAt ? new Date(room.connectedAt).toISOString() : null,
        duration_seconds: Math.max(0, Math.floor((now - room.createdAt) / 1000)),
        coins_spent: coinsSpent,
      };
    });
  },
  forceEndRoom(roomId) {
    const id = String(roomId || '').trim();
    if (!id || !chatRooms.has(id)) return false;
    endChatRoom(id, null, { notifySelf: true, reason: 'admin-force-end' });
    return true;
  },
});

function cleanupInMemoryChatQueue() {
  const cutoff = Date.now() - 45_000;
  for (const entry of chatQueueEntries.values()) {
    const peerSocket = io.sockets.sockets.get(entry.socketId);
    if (!peerSocket || !peerSocket.connected || entry.joinedAt < cutoff) {
      chatQueueEntries.delete(entry.userId);
      peerSocket?.emit('chat:ended', { reason: 'queue-timeout' });
    }
  }
}

const liveRooms = new Map(); // liveId -> { viewers: Map<viewerKey, Set<socketId>>, hosts, mutedUsers, likes, giftsTotal, comments }

function normalizeLiveId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) return '';
  return id;
}

function cleanLiveText(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function getLiveRoomState(liveId) {
  const id = normalizeLiveId(liveId);
  if (!id) return null;
  if (!liveRooms.has(id)) {
    liveRooms.set(id, {
      viewers: new Map(),
      hosts: new Set(),
      mutedUsers: new Map(),
      likes: 0,
      giftsTotal: 0,
      comments: [],
      lastSeen: Date.now(),
    });
  }
  return liveRooms.get(id);
}

function getSocketLivePresence(socket) {
  socket.data.livePresence = socket.data.livePresence || new Map();
  return socket.data.livePresence;
}

function addLiveViewer(liveId, viewerKey, socketId) {
  const state = getLiveRoomState(liveId);
  if (!state || !viewerKey || !socketId) return 0;
  const sockets = state.viewers.get(viewerKey) || new Set();
  sockets.add(socketId);
  state.viewers.set(viewerKey, sockets);
  state.lastSeen = Date.now();
  return state.viewers.size;
}

function removeLiveViewer(liveId, viewerKey, socketId) {
  const state = getLiveRoomState(liveId);
  if (!state || !viewerKey || !socketId) return 0;
  const sockets = state.viewers.get(viewerKey);
  if (!sockets) return state.viewers.size;
  sockets.delete(socketId);
  if (sockets.size === 0) state.viewers.delete(viewerKey);
  state.lastSeen = Date.now();
  return state.viewers.size;
}

function emitLiveViewerCount(liveId) {
  const state = getLiveRoomState(liveId);
  const viewersCount = state ? state.viewers.size : 0;
  io.to(liveId).emit('update-viewers', { liveId, viewersCount });
  return viewersCount;
}

async function hydrateLiveSocketState(liveId) {
  const state = getLiveRoomState(liveId);
  if (!state) return null;
  try {
    const live = await liveCtrl.getLive(liveId);
    if (live) {
      state.likes = Number(live.total_likes || live.totalLikes || state.likes || 0);
      state.giftsTotal = Number(live.total_gifts_amount || live.totalGiftsAmount || state.giftsTotal || 0);
    }
    return live;
  } catch {
    return null;
  }
}

async function socketCanModerateLive(socket, liveId) {
  if (!socket?.uid || socket.isGuest) return false;
  const live = await liveCtrl.getLive(liveId).catch(() => null);
  return Boolean(live?.host_id && String(live.host_id) === String(socket.uid));
}

function emitLiveError(socket, message) {
  socket.emit('live:error', { message });
}

async function joinLiveSocket(socket, payload = {}) {
  const liveId = normalizeLiveId(payload.liveId || payload.sessionId || payload.id);
  if (!liveId) return;

  const requestedUserId = cleanLiveText(payload.userId || socket.uid, 140) || socket.uid;
  const viewerKey = socket.isGuest ? `guest:${socket.id}` : String(socket.uid || requestedUserId);
  const state = getLiveRoomState(liveId);
  socket.join(liveId);

  let isHost = false;
  try {
    const joined = await liveCtrl.joinLive(liveId, requestedUserId);
    isHost = joined?.role === 'host';
    const live = await hydrateLiveSocketState(liveId);
    if (live?.host_id && String(live.host_id) === String(requestedUserId)) isHost = true;
  } catch (err) {
    console.warn('[live] join failed:', err?.message || err);
  }

  if (isHost) {
    state.hosts.add(socket.id);
  } else {
    addLiveViewer(liveId, viewerKey, socket.id);
  }

  getSocketLivePresence(socket).set(liveId, {
    viewerKey,
    userId: requestedUserId,
    counted: !isHost,
  });

  const viewersCount = emitLiveViewerCount(liveId);
  socket.emit('live:joined', {
    liveId,
    role: isHost ? 'host' : 'viewer',
    viewersCount,
    totalLikes: state.likes,
    totalGiftsAmount: state.giftsTotal,
  });
}

async function leaveLiveSocket(socket, payload = {}) {
  const liveId = normalizeLiveId(payload.liveId || payload.sessionId || payload.id);
  if (!liveId) return;

  const presence = getSocketLivePresence(socket);
  const entry = presence.get(liveId);
  const viewerKey = entry?.viewerKey || (socket.isGuest ? `guest:${socket.id}` : String(socket.uid || payload.userId || socket.id));
  if (entry?.counted) removeLiveViewer(liveId, viewerKey, socket.id);

  const state = getLiveRoomState(liveId);
  state?.hosts.delete(socket.id);
  presence.delete(liveId);
  socket.leave(liveId);

  if (entry?.counted) {
    liveCtrl.leaveLive(liveId, entry.userId || viewerKey).catch((err) => {
      console.warn('[live] leave failed:', err?.message || err);
    });
  }
  emitLiveViewerCount(liveId);
}

function leaveAllLiveRooms(socket) {
  const presence = getSocketLivePresence(socket);
  const entries = Array.from(presence.entries());
  for (const [liveId, entry] of entries) {
    if (entry?.counted) {
      removeLiveViewer(liveId, entry.viewerKey, socket.id);
      liveCtrl.leaveLive(liveId, entry.userId || entry.viewerKey).catch(() => {});
    }
    getLiveRoomState(liveId)?.hosts.delete(socket.id);
    emitLiveViewerCount(liveId);
    socket.leave(liveId);
  }
  presence.clear();
}

io.on('connection', (socket) => {
  if (!socket.isGuest && socket.uid) {
    socket.join(`user:${socket.uid}`);
  }

  socket.on('admin:api-monitoring:subscribe', async (payload = {}) => {
    try {
      const headerToken = socket.handshake.headers?.authorization?.replace('Bearer ', '');
      const token = payload.token || socket.handshake.auth?.adminToken || headerToken;
      const admin = await resolveAdminSessionFromToken(token);
      if (!admin) {
        socket.emit('admin:api-monitoring:error', { message: 'Admin token required.' });
        return;
      }

      socket.admin = admin;
      socket.join('admin:api-monitoring');
      const snapshot = await getApiOverview({ range: payload.range || '1h' });
      socket.emit('admin:api-monitoring:update', snapshot);
    } catch {
      socket.emit('admin:api-monitoring:error', { message: 'Could not subscribe to API monitoring.' });
    }
  });

  socket.on('admin:api-monitoring:unsubscribe', () => {
    socket.leave('admin:api-monitoring');
  });

  socket.on('admin:ai-moderation:subscribe', async (payload = {}) => {
    try {
      const headerToken = socket.handshake.headers?.authorization?.replace('Bearer ', '');
      const token = payload.token || socket.handshake.auth?.adminToken || headerToken;
      const admin = await resolveAdminSessionFromToken(token);
      const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
      const role = String(admin?.role || '').toLowerCase();
      const allowed = admin?.is_super_admin ||
        ['admin', 'moderator', 'operations', 'support'].includes(role) ||
        permissions.includes('ai_moderator') ||
        permissions.includes('/ai-moderator');
      if (!allowed) {
        socket.emit('admin:ai-moderation:error', { message: 'AI moderation admin token required.' });
        return;
      }

      socket.admin = admin;
      socket.join('admin:ai-moderation');
      socket.emit('admin:ai-moderation:update', await getAiModerationOverview());
    } catch {
      socket.emit('admin:ai-moderation:error', { message: 'Could not subscribe to AI moderation.' });
    }
  });

  socket.on('admin:ai-moderation:unsubscribe', () => {
    socket.leave('admin:ai-moderation');
  });

  socket.on('join-live', (payload = {}) => {
    joinLiveSocket(socket, payload).catch((err) => {
      console.error('[live] join socket error:', err?.message || err);
      emitLiveError(socket, 'Could not join this live stream.');
    });
  });

  socket.on('leave-live', (payload = {}) => {
    leaveLiveSocket(socket, payload).catch(() => {});
  });

  socket.on('live:host-register', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can manage this stream.');
    const state = getLiveRoomState(liveId);
    state.hosts.add(socket.id);
    const entry = getSocketLivePresence(socket).get(liveId);
    if (entry?.counted) {
      removeLiveViewer(liveId, entry.viewerKey, socket.id);
      entry.counted = false;
      getSocketLivePresence(socket).set(liveId, entry);
      emitLiveViewerCount(liveId);
    }
    socket.join(liveId);
    ensureAiSession({
      sessionId: liveId,
      sessionType: 'livestream',
      creatorId: socket.uid,
      title: 'Livestream',
      metadata: { hidden: true, role: 'system_ai', hostSocket: socket.id },
      io,
    }).catch((error) => console.warn('[ai-moderation] live session init failed:', error?.message || error));
  });

  socket.on('comment-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const message = cleanLiveText(payload.message || payload.text, 500);
    if (!liveId || !message) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to comment on live streams.');
    if (!checkSocketRate(socket, 'live:comment', 35, 60_000)) return emitLiveError(socket, 'You are commenting too quickly.');

    const state = getLiveRoomState(liveId);
    const userKey = String(socket.uid);
    const mutedUntil = state.mutedUsers.get(userKey);
    if (mutedUntil && mutedUntil > Date.now()) return emitLiveError(socket, 'You are muted in this stream.');
    if (mutedUntil) state.mutedUsers.delete(userKey);

    const authorName = cleanLiveText(payload.authorName || payload.author_name || 'Viewer', 80) || 'Viewer';
    let record = null;
    try {
      record = await liveCtrl.commentLive(liveId, socket.uid, message);
    } catch (err) {
      console.warn('[live] comment persistence failed:', err?.message || err);
    }
    const comment = {
      id: record?.id || randomUUID(),
      liveId,
      userId: socket.uid,
      user_id: socket.uid,
      authorName,
      message,
      createdAt: record?.created_at || new Date().toISOString(),
    };
    state.comments.push(comment);
    state.comments = state.comments.slice(-200);
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'live_comment',
      source: 'socket',
      userId: socket.uid,
      contentType: 'chat',
      contentId: comment.id,
      message,
      metadata: { authorName, liveId },
      io,
    }).catch(() => {});
    io.to(liveId).emit('new-comment', comment);
  });

  socket.on('like-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to like live streams.');
    if (!checkSocketRate(socket, 'live:like', 120, 60_000)) return;

    const state = getLiveRoomState(liveId);
    let nextLikes = state.likes + 1;
    try {
      const live = await liveCtrl.likeLive(liveId);
      nextLikes = Number(live?.total_likes ?? live?.totalLikes ?? nextLikes);
    } catch (err) {
      console.warn('[live] like persistence failed:', err?.message || err);
    }
    state.likes = nextLikes;
    io.to(liveId).emit('update-likes', { liveId, totalLikes: nextLikes });
    io.to(liveId).emit('new-reaction', {
      id: randomUUID(),
      liveId,
      userId: socket.uid,
      type: cleanLiveText(payload.type || 'heart', 40),
      createdAt: Date.now(),
    });
  });

  socket.on('gift-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (socket.isGuest) return emitLiveError(socket, 'Sign in to send gifts.');
    if (!checkSocketRate(socket, 'live:gift', 30, 60_000)) return emitLiveError(socket, 'You are sending gifts too quickly.');
    emitLiveError(socket, 'Gift payments are processed by the secure gift API.');
  });

  socket.on('pause-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can pause this stream.');
    await liveCtrl.pauseLive(liveId).catch((err) => console.warn('[live] pause failed:', err?.message || err));
    io.to(liveId).emit('live-paused', { liveId });
    io.emit('live_paused', { liveId });
  });

  socket.on('resume-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can resume this stream.');
    await liveCtrl.resumeLive(liveId).catch((err) => console.warn('[live] resume failed:', err?.message || err));
    io.to(liveId).emit('live-resumed', { liveId });
    io.emit('live_resumed', { liveId });
  });

  socket.on('end-live', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    if (!liveId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can end this stream.');
    const payout = await liveCtrl.endLive(liveId, { requesterId: socket.uid }).catch((err) => {
      console.warn('[live] end failed:', err?.message || err);
      return null;
    });
    io.to(liveId).emit('live-ended', { liveId, payout });
    io.emit('live_ended', { liveId, payout });
    endAiSession({ sessionId: liveId, status: 'ended', metadata: { reason: 'host_ended', endedBy: socket.uid }, io }).catch(() => {});
    liveRooms.delete(liveId);
  });

  socket.on('live:thumbnail-update', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const thumbnail = String(payload.thumbnail || '');
    if (!liveId || !thumbnail || thumbnail.length > 350_000) return;
    if (!checkSocketRate(socket, 'live:thumbnail', 12, 60_000)) return;
    if (!(await socketCanModerateLive(socket, liveId))) return;
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'livestream_frame',
      source: 'socket',
      userId: socket.uid,
      contentType: 'frame',
      contentRef: `thumbnail:${Date.now()}`,
      metadata: {
        liveId,
        frameBytes: thumbnail.length,
        snapshotUrl: thumbnail.startsWith('data:') ? null : thumbnail.slice(0, 500),
      },
      io,
    }).catch(() => {});
    io.emit('live:thumbnail-update', { liveId, thumbnail });
  });

  socket.on('live:delete-comment', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const commentId = cleanLiveText(payload.commentId || payload.id, 120);
    if (!liveId || !commentId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can moderate this stream.');
    const state = getLiveRoomState(liveId);
    state.comments = state.comments.filter((comment) => String(comment.id) !== commentId);
    io.to(liveId).emit('live:comment-deleted', { liveId, commentId });
  });

  socket.on('live:mute-user', async (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const targetUserId = cleanLiveText(payload.userId || payload.user_id, 140);
    if (!liveId || !targetUserId) return;
    if (!(await socketCanModerateLive(socket, liveId))) return emitLiveError(socket, 'Only the host can moderate this stream.');
    const durationMs = Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Number(payload.durationMs) || 10 * 60_000));
    getLiveRoomState(liveId).mutedUsers.set(targetUserId, Date.now() + durationMs);
    io.to(liveId).emit('live:user-muted', { liveId, userId: targetUserId, durationMs });
  });

  socket.on('live:report', (payload = {}) => {
    const liveId = normalizeLiveId(payload.liveId);
    const reason = cleanLiveText(payload.reason || 'reported', 250);
    console.warn('[live] report', {
      liveId,
      reporter: socket.uid,
      reason,
    });
    recordModerationSignal({
      sessionId: liveId,
      sessionType: 'livestream',
      eventType: 'user_report',
      source: 'socket',
      userId: socket.uid,
      contentType: 'behavior',
      message: reason,
      metadata: { riskScore: 70, reason },
      io,
    }).catch(() => {});
    socket.emit('live:report-received', { liveId });
  });

  socket.on('chat:find-match', async (payload = {}) => {
    try {
      if (socket.isGuest) {
        socket.emit('chat:error', { message: 'Please sign in to use random video chat.' });
        return;
      }
      if (!checkSocketRate(socket, 'chat:find-match', 12, 60_000)) {
        socket.emit('chat:error', { message: 'You are searching too quickly. Please wait a moment.' });
        return;
      }

      leaveSocketRooms(socket);
      removeQueuedUser(socket.uid);

      const requesterAccess = await getSocketChatAccess(socket);
      if (!requesterAccess) return;

      const ownGender = normalizeChatGender(payload.ownGender || payload.selfGender || payload.myGender || payload.genderIdentity);
      const preferredGender = normalizeChatGender(payload.preferredGender || payload.preference || payload.gender);
      const requester = {
        userId: socket.uid,
        socketId: socket.id,
        gender: ownGender,
        preference: preferredGender,
        joinedAt: Date.now(),
      };

      const match = await findCompatiblePeer(requester);
      if (match?.peer) {
        await createChatRoom(requester, match.peer, requesterAccess, match.peerAccess);
        return;
      }

      chatQueueEntries.set(requester.userId, requester);
      chatQueue.enqueueUser(requester.userId, requester.gender, socket.id).catch(() => {});
      socket.emit('chat:waiting', {
        gender: requester.gender,
        preference: requester.preference,
      });
    } catch (err) {
      console.error('[chat] find-match error:', err?.message || err);
      socket.emit('chat:error', { message: 'Could not start matchmaking. Please try again.' });
    }
  });

  socket.on('chat:webrtc-offer', ({ roomId, offer } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 300, 60_000)) return;
    if (!isValidSessionDescription(offer, 'offer')) return;
    emitToRoomPeer(socket, roomId, 'chat:webrtc-offer', { offer });
  });

  socket.on('chat:webrtc-answer', ({ roomId, answer } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 300, 60_000)) return;
    if (!isValidSessionDescription(answer, 'answer')) return;
    emitToRoomPeer(socket, roomId, 'chat:webrtc-answer', { answer });
  });

  socket.on('chat:ice-candidate', ({ roomId, candidate } = {}) => {
    if (!checkSocketRate(socket, 'chat:signal', 500, 60_000)) return;
    if (!isValidIceCandidate(candidate)) return;
    emitToRoomPeer(socket, roomId, 'chat:ice-candidate', { candidate });
  });

  socket.on('chat:ready', ({ roomId } = {}) => {
    const room = getRoomForSocket(socket, roomId);
    if (!room) return;
    room.ready.add(socket.uid);
    maybeStartChatBilling(room);
  });

  socket.on('chat:media-state', ({ roomId, muted, cameraOff } = {}) => {
    emitToRoomPeer(socket, roomId, 'chat:media-state', {
      muted: muted === true,
      cameraOff: cameraOff === true,
    });
  });

  socket.on('chat:send-gift', async (payload = {}) => {
    const roomId = String(payload.roomId || '').trim();
    const giftId = String(payload.giftId || payload.gift?.id || '').trim();
    if (!roomId || !giftId) return;
    if (socket.isGuest) return socket.emit('chat:error', { message: 'Sign in to send gifts.' });
    if (!checkSocketRate(socket, 'chat:gift', 30, 60_000)) {
      return socket.emit('chat:error', { message: 'You are sending gifts too quickly.' });
    }

    const room = getRoomForSocket(socket, roomId);
    if (!room) return socket.emit('chat:error', { message: 'Chat session is no longer active.' });

    const senderName = cleanLiveText(payload.senderName || 'Viewer', 80) || 'Viewer';
    const giftName = cleanLiveText(payload.giftName || payload.gift?.name || giftId, 80) || giftId;
    const amount = Number(payload.amount ?? payload.gift?.price ?? payload.gift?.coinCost ?? 0);
    const emoji = cleanLiveText(payload.emoji || payload.gift?.emoji || '', 20);

    if (payload.tokenPaid === true) {
      return;
    }

    const peerId = chatPeerUserId(room, socket.uid);
    try {
      const result = await sendCreatorGift({
        userId: socket.uid,
        senderName,
        creatorId: peerId,
        streamId: roomId,
        giftId,
        gift: payload.gift,
      });

      io.to(room.roomId).emit('chat:gift', {
        id: randomUUID(),
        roomId: room.roomId,
        senderId: socket.uid,
        senderName,
        giftId,
        giftName: result.gift?.name || giftName,
        emoji: result.gift?.emoji || emoji,
        imageUrl: result.gift?.imageUrl || null,
        amount: Number(result.gift?.coinCost || amount),
        createdAt: new Date().toISOString(),
      });

      socket.emit('chat:gift-sent', { newBalance: result.newBalance, giftId: result.giftId });
    } catch (err) {
      socket.emit('chat:error', { message: err?.message || 'Gift failed.' });
    }
  });

  socket.on('chat:message', ({ roomId, text } = {}) => {
    if (!checkSocketRate(socket, 'chat:message', 60, 60_000)) return;
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed) return;
    const room = getRoomForSocket(socket, roomId);
    if (room) {
      recordModerationSignal({
        sessionId: room.roomId,
        sessionType: 'ivi',
        eventType: 'chat_message',
        source: 'socket',
        userId: socket.uid,
        peerUserId: chatPeerUserId(room, socket.uid),
        contentType: 'chat',
        message: trimmed,
        metadata: { roomId: room.roomId },
        io,
      }).catch(() => {});
    }
    emitToRoomPeer(socket, roomId, 'chat:message', {
      text: trimmed,
      ts: Date.now(),
    });
  });

  socket.on('chat:report', ({ roomId, reason } = {}) => {
    const cleanReason = String(reason || 'reported').trim().slice(0, 250);
    const room = getRoomForSocket(socket, roomId);
    if (!room) return;
    console.warn('[chat] report', {
      roomId: room.roomId,
      reporter: socket.uid,
      reason: cleanReason,
      peer: room.a.userId === socket.uid ? room.b.userId : room.a.userId,
    });
    recordModerationSignal({
      sessionId: room.roomId,
      sessionType: 'ivi',
      eventType: 'user_report',
      source: 'socket',
      userId: socket.uid,
      peerUserId: chatPeerUserId(room, socket.uid),
      contentType: 'behavior',
      message: cleanReason,
      metadata: { riskScore: 70, reason: cleanReason },
      io,
    }).catch(() => {});
    socket.emit('chat:report-received', { roomId: room.roomId });
  });

  socket.on('chat:next', ({ roomId } = {}) => {
    if (roomId) endChatRoom(roomId, socket.uid, { notifySelf: false, reason: 'next' });
    removeQueuedUser(socket.uid);
  });

  socket.on('chat:leave', ({ roomId } = {}) => {
    if (roomId) endChatRoom(roomId, socket.uid, { notifySelf: false, reason: 'left' });
    removeQueuedUser(socket.uid);
  });

  socket.on('disconnect', () => {
    leaveAllLiveRooms(socket);
    removeQueuedUser(socket.uid);
    leaveSocketRooms(socket);
  });
});

setInterval(() => {
  cleanupInMemoryChatQueue();
  chatQueue.cleanupStaleQueue(45).catch(() => {});
}, 30_000).unref?.();

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use.`);
    console.error('[server] Stop the existing backend process or start this server with a different PORT value.');
    console.error(`[server] Windows check: netstat -ano | findstr :${PORT}`);
    console.error('[server] Windows stop: taskkill /PID <PID> /F');
    process.exit(1);
  }

  console.error('[server] Failed to start:', err);
  process.exit(1);
});

server.on('listening', () => {
  serverHasListened = true;
});

server.on('close', () => {
  serverHasListened = false;
});

startMemoryDiagnostics();

server.listen(PORT, async () => {
  logMemoryUsage('server-started');
  console.log(`🚀 Server running on port ${PORT}`);
  const r2Status = getR2ImportStorageStatus();
  if (!r2Status.configured) {
    console.warn('[enterprise-import:r2] Cloudflare R2 import storage is not configured.', {
      missing: r2Status.missing,
      endpointConfigured: r2Status.endpointConfigured,
      bucketConfigured: r2Status.bucketConfigured,
      accessKeyConfigured: r2Status.accessKeyConfigured,
      secretKeyConfigured: r2Status.secretKeyConfigured,
      accountIdConfigured: r2Status.accountIdConfigured,
    });
  } else {
    console.info('[enterprise-import:r2] Cloudflare R2 import storage configured', {
      endpointHost: r2Status.endpointHost,
      bucket: r2Status.bucket,
      region: r2Status.region,
    });
    validateR2ImportBucket()
      .then((result) => console.info('[enterprise-import:r2] Bucket validation ok', result))
      .catch((err) => console.warn('[enterprise-import:r2] Bucket validation failed:', err?.message || err));
  }
  await ensureBuckets().catch(() => {});
  if (isEnabledEnvFlag(process.env.IMPORT_WORKER_AUTOSTART, isRenderRuntime())) {
    assertEnterpriseImportQueueReady()
      .then(async (redis) => {
        console.info('[enterprise-import-worker] Redis queue ready', {
          connected: redis.connected,
          latencyMs: redis.latencyMs,
        });
        await reconcileEnterpriseImportQueue({ source: 'server-startup' }).catch((err) => {
          console.warn('[enterprise-import-worker] startup reconcile failed:', err?.message || err);
        });
        startEnterpriseImportWorker({ signal: enterpriseImportWorkerController.signal }).catch((err) => {
          console.error('[enterprise-import-worker] stopped unexpectedly:', err?.message || err);
        });
      })
      .catch((err) => {
        console.error('[enterprise-import-worker] autostart disabled because Redis queue is unavailable:', err?.message || err);
      });
  } else {
    console.info('[enterprise-import-worker] autostart disabled by IMPORT_WORKER_AUTOSTART=false');
  }
  preloadExternalFeedConfig().catch((err) => {
    console.warn('[externalFeed] config preload failed:', err?.message || err);
  });
  startHealthScanScheduler();
  startSearchSyncScheduler();
  startStorageReplicationWorker();
  syncCacheToSupabase().catch(() => {});
  if (isEnabledEnvFlag(process.env.RTDB_TO_SUPABASE_STARTUP_SYNC, false)) {
    syncRtdbToSupabase({ maxRowsPerBranch: Number(process.env.RTDB_SYNC_MAX_ROWS_PER_BRANCH || 1500) }).catch(() => {});
  } else {
    console.info('[syncRtdbToSupabase] Startup sync disabled by default; set RTDB_TO_SUPABASE_STARTUP_SYNC=true to run the paginated fallback sync.');
  }
});

let shuttingDown = false;
function closeSocketServer() {
  return new Promise((resolve) => {
    try {
      io.close(() => resolve());
    } catch (err) {
      console.warn('[server] Socket.IO close skipped:', err?.message || err);
      resolve();
    }
  });
}

function closeHttpServer() {
  return new Promise((resolve, reject) => {
    if (!serverHasListened || !server.listening) {
      console.log('[server] HTTP listener already closed or not started.');
      resolve();
      return;
    }

    server.close((err) => {
      if (err?.code === 'ERR_SERVER_NOT_RUNNING') {
        console.log('[server] HTTP listener already closed.');
        resolve();
        return;
      }
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function gracefulShutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received; closing realtime and HTTP listeners.`);
  enterpriseImportWorkerController.abort();
  const forceTimer = setTimeout(() => {
    console.error('[server] Forced shutdown after timeout.');
    process.exit(1);
  }, 15_000).unref?.();

  try {
    await closeSocketServer();
    await closeHttpServer();
    clearTimeout(forceTimer);
    console.log('[server] Shutdown complete.');
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(forceTimer);
    console.error('[server] Shutdown failed:', err);
    process.exit(exitCode || 1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  gracefulShutdown('uncaughtException', 1);
});
