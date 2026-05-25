import {
  listProviders,
  getProviderById,
  updateProvider,
  listZones,
  upsertZone,
  deleteZone,
  getPriorityOrder,
  savePriorityOrder,
  getPublicAdConfig,
  getAuditLog,
  invalidateConfigCache,
} from '../services/adProvider.service.js';
import {
  recordMonitoringEvent,
  getMonitoringOverview,
  getRecentEvents,
  getSessionTimeline,
  getProviderAnalytics,
  getDailyAnalytics,
} from '../services/adMonitoring.service.js';
import {
  runFullHealthScan,
  scanProvider,
  getHealthHistory,
  getJuicyAdsDiagnostics,
  probeVastTag,
  resolveFallbackProvider,
} from '../services/adHealthScanner.service.js';
import {
  listAdSlots,
  upsertAdSlot,
  patchAdSlot,
  deleteAdSlot,
  getPublicSlotsConfig,
  AD_SIZES,
  AD_PAGES,
  invalidateSlotCache,
} from '../services/adSlot.service.js';
import { getPlatformSettingsMap, saveAdminSettings } from '../services/platformSettings.service.js';
import {
  APPROVED_PLACEMENTS,
  APPROVED_MONETAG_SCRIPT_URL,
  APPROVED_MONETAG_ZONE_ID,
  MONETAG_SAFE_DOMAINS,
  SAFE_DISPLAY_FORMATS,
  getPublicSafeAdPolicy,
  getSafeAdPolicySettings,
  isApprovedMonetagScriptUrl,
  validateAdForRender,
} from '../services/safeAdPolicy.service.js';

const SAFE_JUICY_SCRIPT_URL = 'https://poweredby.jads.co/js/jads.js';
const EXOCLICK_DISPLAY_SCRIPT_URL = 'https://a.magsrv.com/ad-provider.js';
const EXOCLICK_DISPLAY_ZONE_ID = '5933054';
const EXOCLICK_DISPLAY_CONFIG = {
  insClass: 'eas6a97888e6',
  keywords: 'keywords',
  sub: '123450000',
  blockAdTypes: '0',
  exAv: 'name',
};
const EXOCLICK_DISPLAY_ZONES = [
  { placement: 'leaderboard', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 728, height: 90, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'homepage_banner', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 728, height: 90, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'banner', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 728, height: 90, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'feed', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 640, height: 360, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'native_card', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 640, height: 360, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'between_content', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 728, height: 90, config: EXOCLICK_DISPLAY_CONFIG },
  { placement: 'sidebar', zoneId: EXOCLICK_DISPLAY_ZONE_ID, tagUrl: EXOCLICK_DISPLAY_SCRIPT_URL, width: 300, height: 250, config: EXOCLICK_DISPLAY_CONFIG },
];
const SAFE_AD_DOMAINS = [
  'juicyads.com',
  'www.juicyads.com',
  'js.juicyads.com',
  'poweredby.jads.co',
  'jads.co',
  'exoclick.com',
  'magsrv.com',
  'a.magsrv.com',
  's.magsrv.com',
  'googleads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'googlesyndication.com',
  'quge5.com',
  'monetag.com',
  'www.monetag.com',
  'highperformanceformat.com',
  'profitablecpmrate.com',
  'profitablecpmgate.com',
  'alwingulla.com',
];
const SAFE_AD_DOMAINS_JSON = JSON.stringify(SAFE_AD_DOMAINS);
const SAFE_PROVIDER_PRIORITY_JSON = JSON.stringify(['exoclick', 'juicyads', 'monetag', 'google_ad_manager']);
const BLOCKED_SCRIPT_PATTERN =
  /adserver\.juicyads\.com|popunder|clickunder|interstitial|popup|auto.?redirect|direct.?link|social.?bar|window\.open|top\.location|betway|casino|popads|popcash|propellerads|onclickads/i;
const QUGE5_HOST_PATTERN = /quge5\.com/i;

function normalizeJuicyScriptUrl(url) {
  const value = String(url || '').trim();
  if (!value || BLOCKED_SCRIPT_PATTERN.test(value.toLowerCase()) || QUGE5_HOST_PATTERN.test(value.toLowerCase())) return SAFE_JUICY_SCRIPT_URL;
  return value;
}

function isUnsafeProviderScriptUrl(providerId, url) {
  const value = String(url || '').trim();
  if (!value) return false;
  const provider = String(providerId || '').toLowerCase();
  if (provider === 'monetag' && isApprovedMonetagScriptUrl(value)) return false;
  if (QUGE5_HOST_PATTERN.test(value.toLowerCase())) return true;
  return BLOCKED_SCRIPT_PATTERN.test(value.toLowerCase());
}

function defaultZoneDimensions(placement) {
  const specs = {
    video_preroll: { width: 1920, height: 1080 },
    sidebar: { width: 300, height: 250 },
    home_sidebar: { width: 300, height: 250 },
    video_sidebar: { width: 300, height: 250 },
    video_recommended: { width: 300, height: 250 },
    creator_sidebar: { width: 300, height: 250 },
    live_sidebar: { width: 300, height: 250 },
    feed_sidebar: { width: 300, height: 250 },
    search_sidebar: { width: 300, height: 250 },
    homepage_banner: { width: 970, height: 120 },
    leaderboard: { width: 728, height: 90 },
    feed: { width: 728, height: 90 },
    native_card: { width: 640, height: 360 },
    between_content: { width: 728, height: 90 },
    banner: { width: 728, height: 90 },
  };
  return specs[placement] || specs.sidebar;
}

function inferSafeFormat(providerSlug, placement) {
  if (providerSlug === 'exoclick' && placement === 'video_preroll') return 'vast';
  if (['feed', 'native_card', 'between_content'].includes(String(placement || ''))) return 'native';
  return 'banner';
}

function dedupeSettings(settings) {
  const map = new Map();
  for (const item of settings || []) {
    if (!item?.key) continue;
    map.set(String(item.key), { key: String(item.key), value: String(item.value ?? '') });
  }
  return [...map.values()];
}

function diagnosticsFor(req, endpoint, err) {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    fallback: true,
    endpoint,
    requestId: req.requestId,
    reason: isProduction ? 'service_unavailable' : (err?.message || String(err || 'service_unavailable')),
  };
}

function logPublicAdRouteFailure(req, endpoint, err) {
  console.warn('[ad-providers:public:fallback]', {
    requestId: req.requestId,
    endpoint,
    method: req.method,
    path: req.originalUrl,
    message: err?.message || String(err),
    code: err?.code,
  });
}

function sendFallbackJson(req, res, endpoint, payload, err) {
  logPublicAdRouteFailure(req, endpoint, err);
  res.setHeader('X-Ad-Provider-Fallback', 'true');
  res.status(200).json({
    ...payload,
    diagnostics: diagnosticsFor(req, endpoint, err),
  });
}

function fallbackSafePolicy() {
  return {
    strictMode: true,
    allowPopups: false,
    allowRedirects: false,
    allowFloatingAds: false,
    blockAggressiveBehavior: true,
    blockInterstitials: true,
    blockClickHijacking: true,
    safeFormatsOnly: true,
    maxGlobalWidth: 970,
    maxGlobalHeight: 600,
    allowedPlacements: Object.keys(APPROVED_PLACEMENTS),
    approvedPlacements: Object.keys(APPROVED_PLACEMENTS),
    placementSpecs: APPROVED_PLACEMENTS,
    allowedDomains: SAFE_AD_DOMAINS,
    allowedFormats: SAFE_DISPLAY_FORMATS,
    safeDisplayFormats: SAFE_DISPLAY_FORMATS,
    blockedFormats: ['popunder', 'clickunder', 'floating', 'fullscreen_takeover', 'interstitial', 'popup', 'modal'],
    guardEnabled: true,
    clickIsolation: true,
    prerollEnabled: true,
    feedAdsEnabled: true,
    sidebarAdsEnabled: true,
    bannerAdsEnabled: true,
    juicyScriptUrl: SAFE_JUICY_SCRIPT_URL,
    monetagEnabled: true,
    monetagNativeEnabled: true,
    monetagSidebarEnabled: true,
    monetagBannerEnabled: true,
    monetagScriptUrl: APPROVED_MONETAG_SCRIPT_URL,
    monetagNativeZoneId: APPROVED_MONETAG_ZONE_ID,
    monetagSidebarZoneId: APPROVED_MONETAG_ZONE_ID,
    monetagBannerZoneId: APPROVED_MONETAG_ZONE_ID,
    monetagAllowedPages: ['home', 'video', 'creator', 'feed', 'search', 'live'],
    monetagAllowedSlots: [
      'feed_native',
      'home_sidebar',
      'video_sidebar',
      'video_recommended',
      'creator_sidebar',
      'live_sidebar',
      'feed_sidebar',
      'search_sidebar',
      'homepage_banner',
      'leaderboard',
      'banner',
    ],
    monetagAllowedDomains: MONETAG_SAFE_DOMAINS,
  };
}

function fallbackAdConfig() {
  const safePolicy = fallbackSafePolicy();
  return {
    priority: JSON.parse(SAFE_PROVIDER_PRIORITY_JSON),
    autoFallback: true,
    providers: [
      {
        id: 'monetag',
        slug: 'monetag',
        name: 'Monetag',
        type: 'display',
        allowedFormats: ['native', 'banner', 'display'],
        blockedFormats: safePolicy.blockedFormats,
        scriptUrl: APPROVED_MONETAG_SCRIPT_URL,
        config: { safeMode: true, sandboxed: true },
        skipAfterSeconds: 5,
        skippable: true,
        adFrequency: 3,
        timeoutMs: 8000,
        retryLimit: 2,
        zones: [
          { placement: 'feed', zoneId: APPROVED_MONETAG_ZONE_ID, tagUrl: null, width: 640, height: 360 },
          { placement: 'sidebar', zoneId: APPROVED_MONETAG_ZONE_ID, tagUrl: null, width: 300, height: 250 },
          { placement: 'leaderboard', zoneId: APPROVED_MONETAG_ZONE_ID, tagUrl: null, width: 728, height: 90 },
        ],
      },
      {
        id: 'juicyads',
        slug: 'juicyads',
        name: 'JuicyAds',
        type: 'display',
        allowedFormats: ['banner', 'display'],
        blockedFormats: safePolicy.blockedFormats,
        scriptUrl: SAFE_JUICY_SCRIPT_URL,
        config: { queueKey: 'adsbyjuicy', defaultZoneId: '1118510', defaultWidth: 300, defaultHeight: 250 },
        skipAfterSeconds: 5,
        skippable: true,
        adFrequency: 3,
        timeoutMs: 8000,
        retryLimit: 2,
        zones: [
          { placement: 'sidebar', zoneId: '1118510', tagUrl: null, width: 300, height: 250 },
        ],
      },
      {
        id: 'exoclick',
        slug: 'exoclick',
        name: 'ExoClick',
        type: 'display',
        allowedFormats: ['banner', 'display', 'native'],
        blockedFormats: safePolicy.blockedFormats,
        scriptUrl: EXOCLICK_DISPLAY_SCRIPT_URL,
        config: EXOCLICK_DISPLAY_CONFIG,
        skipAfterSeconds: 5,
        skippable: true,
        adFrequency: 3,
        timeoutMs: 8000,
        retryLimit: 2,
        zones: EXOCLICK_DISPLAY_ZONES,
      },
    ],
    vast: {
      timeoutSec: 8,
      skipAfterSeconds: 5,
      estimatedCpmUsd: 2,
    },
    safePolicy,
  };
}

function fallbackSlotsConfig({ page = null } = {}) {
  const slots = [
    { slotKey: 'home_sidebar', name: 'Home Sidebar MPU', page: 'home', location: 'sidebar', width: 300, height: 250, sizeLabel: '300x250', providerType: 'mixed', providerId: 'monetag', zoneId: APPROVED_MONETAG_ZONE_ID, placement: 'sidebar', displayMode: 'third_party_first', customEnabled: true, thirdPartyEnabled: true, deviceTarget: 'all', priority: 10, embedCode: null },
    { slotKey: 'video_sidebar', name: 'Video Page Sidebar', page: 'video', location: 'sidebar', width: 300, height: 250, sizeLabel: '300x250', providerType: 'mixed', providerId: 'monetag', zoneId: APPROVED_MONETAG_ZONE_ID, placement: 'video_sidebar', displayMode: 'third_party_first', customEnabled: true, thirdPartyEnabled: true, deviceTarget: 'all', priority: 20, embedCode: null },
    { slotKey: 'video_recommended', name: 'Video Recommended Sidebar', page: 'video', location: 'recommended', width: 300, height: 250, sizeLabel: '300x250', providerType: 'mixed', providerId: 'monetag', zoneId: APPROVED_MONETAG_ZONE_ID, placement: 'video_recommended', displayMode: 'third_party_first', customEnabled: true, thirdPartyEnabled: true, deviceTarget: 'all', priority: 30, embedCode: null },
    { slotKey: 'creator_sidebar', name: 'Creator Sidebar MPU', page: 'creator', location: 'sidebar', width: 300, height: 250, sizeLabel: '300x250', providerType: 'mixed', providerId: 'monetag', zoneId: APPROVED_MONETAG_ZONE_ID, placement: 'creator_sidebar', displayMode: 'third_party_first', customEnabled: true, thirdPartyEnabled: true, deviceTarget: 'all', priority: 40, embedCode: null },
    { slotKey: 'live_sidebar', name: 'Live Sidebar MPU', page: 'live', location: 'sidebar', width: 300, height: 250, sizeLabel: '300x250', providerType: 'mixed', providerId: 'monetag', zoneId: APPROVED_MONETAG_ZONE_ID, placement: 'live_sidebar', displayMode: 'third_party_first', customEnabled: true, thirdPartyEnabled: true, deviceTarget: 'all', priority: 50, embedCode: null },
  ];
  const filteredSlots = page ? slots.filter((slot) => slot.page === page) : slots;
  return {
    enabled: true,
    customEnabled: true,
    thirdPartyEnabled: true,
    juicyAds: {
      enabled: true,
      scriptUrl: SAFE_JUICY_SCRIPT_URL,
      zoneId: '1118510',
      width: 300,
      height: 250,
    },
    monetag: {
      enabled: true,
      nativeEnabled: true,
      sidebarEnabled: true,
      bannerEnabled: true,
      scriptUrl: APPROVED_MONETAG_SCRIPT_URL,
      allowedDomains: MONETAG_SAFE_DOMAINS,
      zones: {
        native: APPROVED_MONETAG_ZONE_ID,
        sidebar: APPROVED_MONETAG_ZONE_ID,
        banner: APPROVED_MONETAG_ZONE_ID,
      },
      allowedPages: ['home', 'video', 'creator', 'feed', 'search', 'live'],
      allowedSlots: slots.map((slot) => slot.slotKey),
    },
    slots: filteredSlots,
  };
}

export async function getPublicAdConfigHandler(req, res) {
  try {
    const config = await getPublicAdConfig();
    res.json(config);
  } catch (err) {
    sendFallbackJson(req, res, 'GET /api/ad-providers/config', fallbackAdConfig(), err);
  }
}

export async function postAdMonitoringEvent(req, res) {
  try {
    const body = req.body || {};
    const id = await recordMonitoringEvent({
      providerId: body.providerId,
      zoneId: body.zoneId,
      sessionId: body.sessionId,
      videoId: body.videoId,
      userId: req.user?.id || body.userId,
      fingerprint: body.fingerprint,
      eventType: body.eventType || body.type || body.event || 'diagnostic',
      placement: body.placement,
      deviceType: body.deviceType,
      browser: body.browser,
      country: body.country,
      revenueUsd: body.revenueUsd,
      metadata: body.metadata,
    });
    res.json({ ok: true, id, stored: Boolean(id) });
  } catch (err) {
    logPublicAdRouteFailure(req, 'POST /api/ad-providers/monitoring/events', err);
    res.setHeader('X-Ad-Provider-Fallback', 'true');
    res.status(202).json({
      ok: true,
      id: null,
      stored: false,
      diagnostics: diagnosticsFor(req, 'POST /api/ad-providers/monitoring/events', err),
    });
  }
}

export async function getAdminProviders(req, res) {
  try {
    const [providers, zones, priority] = await Promise.all([
      listProviders(),
      listZones(),
      getPriorityOrder(),
    ]);
    res.json({ providers, zones, priority });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load providers' });
  }
}

export async function patchAdminProvider(req, res) {
  try {
    const allowed = [
      'is_enabled', 'is_maintenance', 'priority', 'script_url', 'config',
      'estimated_cpm_usd', 'skip_after_seconds', 'skippable', 'ad_frequency',
      'retry_limit', 'timeout_ms', 'name',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    const providerSlug = String(req.params.id || '').toLowerCase();
    if (patch.script_url && isUnsafeProviderScriptUrl(req.params.id, patch.script_url)) {
      if (providerSlug === 'juicyads') patch.script_url = SAFE_JUICY_SCRIPT_URL;
      else return res.status(400).json({ error: 'Unsafe ad script URL is blocked.' });
    }
    if (providerSlug === 'monetag' && patch.script_url) {
      patch.script_url = APPROVED_MONETAG_SCRIPT_URL;
    }
    const data = await updateProvider(req.params.id, patch, req.admin);
    if (providerSlug === 'monetag' && patch.is_enabled !== undefined) {
      const admin = req.adminUser || { name: req.admin?.email || 'Admin', id: req.admin?.id };
      await saveAdminSettings([{ key: 'monetag_enabled', value: patch.is_enabled ? 'true' : 'false' }], admin).catch(() => {});
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update provider' });
  }
}

export async function putAdminPriorityOrder(req, res) {
  try {
    const requestedOrder = Array.isArray(req.body.order) ? req.body.order : [];
    const order = await savePriorityOrder(requestedOrder, req.admin);
    res.json({ order: JSON.parse(order) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save priority' });
  }
}

export async function postAdminZone(req, res) {
  try {
    const providerSlug = String(req.body.provider_id || '').toLowerCase();
    const format = inferSafeFormat(providerSlug, req.body.placement);
    const dims = defaultZoneDimensions(req.body.placement);
    const result = await validateAdForRender({
      placement: req.body.placement,
      width: req.body.width || dims.width,
      height: req.body.height || dims.height,
      providerSlug,
      format,
      tagUrl: req.body.tag_url,
    });
    if (!result.ok) {
      return res.status(400).json({ error: `Unsafe ad zone rejected: ${result.reason}` });
    }
    const zone = await upsertZone(req.body, req.admin);
    res.json(zone);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save zone' });
  }
}

export async function deleteAdminZone(req, res) {
  try {
    await deleteZone(req.params.id, req.admin);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete zone' });
  }
}

export async function getAdminMonitoringOverview(req, res) {
  try {
    const range = req.query.range || '24h';
    const [overview, recent, providers] = await Promise.all([
      getMonitoringOverview(range),
      getRecentEvents(50),
      getProviderAnalytics(range),
    ]);
    res.json({ overview, recent, providers });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load monitoring' });
  }
}

export async function getAdminSessionTimeline(req, res) {
  try {
    const timeline = await getSessionTimeline(req.params.sessionId);
    res.json({ timeline });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load timeline' });
  }
}

export async function getAdminAnalytics(req, res) {
  try {
    const range = req.query.range || '30d';
    const [providers, daily] = await Promise.all([
      getProviderAnalytics(range),
      getDailyAnalytics(range),
    ]);
    res.json({ providers, daily, range });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load analytics' });
  }
}

export async function postAdminHealthScan(req, res) {
  try {
    const providerId = req.body.providerId;
    if (providerId) {
      const provider = await getProviderById(providerId);
      if (!provider) return res.status(404).json({ error: 'Provider not found' });
      const result = await scanProvider(provider, 'manual');
      return res.json({ results: [result] });
    }
    const results = await runFullHealthScan('manual');
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Health scan failed' });
  }
}

export async function getAdminHealthHistory(req, res) {
  try {
    const history = await getHealthHistory(req.query.providerId || null, Number(req.query.limit) || 50);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load health history' });
  }
}

export async function getAdminJuicyDiagnostics(req, res) {
  try {
    const diagnostics = await getJuicyAdsDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Diagnostics failed' });
  }
}

export async function postAdminProbeVast(req, res) {
  try {
    const tagUrl = req.body.tagUrl;
    if (!tagUrl) return res.status(400).json({ error: 'tagUrl required' });
    const result = await probeVastTag(tagUrl, Number(req.body.timeoutMs) || 8000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'VAST probe failed' });
  }
}

export async function postAdminFallback(req, res) {
  try {
    const next = await resolveFallbackProvider(req.body.failedProviderId, req.body.placement);
    res.json({ provider: next });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Fallback resolution failed' });
  }
}

export async function getAdminAuditLog(req, res) {
  try {
    const log = await getAuditLog(Number(req.query.limit) || 50);
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load audit log' });
  }
}

export async function getPublicSlotsConfigHandler(req, res) {
  try {
    const page = req.query.page || null;
    const device = req.query.device || 'desktop';
    const config = await getPublicSlotsConfig({ page, device });
    res.json(config);
  } catch (err) {
    sendFallbackJson(
      req,
      res,
      'GET /api/ad-providers/slots/config',
      fallbackSlotsConfig({ page: req.query.page || null }),
      err,
    );
  }
}

export async function getAdminSlots(req, res) {
  try {
    const [slots, settings] = await Promise.all([listAdSlots(), getPlatformSettingsMap()]);
    res.json({ slots, settings: {
      sidebar_ads_enabled: settings.sidebar_ads_enabled,
      juicyads_sidebar_zone_id: settings.juicyads_sidebar_zone_id,
      juicyads_script_url: settings.juicyads_script_url,
      sidebar_custom_ads_enabled: settings.sidebar_custom_ads_enabled,
      sidebar_third_party_enabled: settings.sidebar_third_party_enabled,
      juicyads_enabled: settings.juicyads_enabled,
      monetag_enabled: settings.monetag_enabled,
      monetag_native_enabled: settings.monetag_native_enabled,
      monetag_sidebar_enabled: settings.monetag_sidebar_enabled,
      monetag_banner_enabled: settings.monetag_banner_enabled,
      monetag_script_url: settings.monetag_script_url,
      monetag_native_zone_id: settings.monetag_native_zone_id,
      monetag_sidebar_zone_id: settings.monetag_sidebar_zone_id,
      monetag_banner_zone_id: settings.monetag_banner_zone_id,
      monetag_allowed_pages: settings.monetag_allowed_pages,
      monetag_allowed_slots: settings.monetag_allowed_slots,
      monetag_allowed_domains: settings.monetag_allowed_domains,
    }, sizes: AD_SIZES, pages: AD_PAGES });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load slots' });
  }
}

export async function postAdminSlot(req, res) {
  try {
    const slot = await upsertAdSlot(req.body, req.admin);
    res.json(slot);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save slot' });
  }
}

export async function patchAdminSlot(req, res) {
  try {
    const slot = await patchAdSlot(req.params.slotKey, req.body, req.admin);
    res.json(slot);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update slot' });
  }
}

export async function deleteAdminSlot(req, res) {
  try {
    await deleteAdSlot(req.params.slotKey, req.admin);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete slot' });
  }
}

export async function getPublicSafeAdPolicyHandler(req, res) {
  try {
    const policy = await getPublicSafeAdPolicy();
    res.json(policy);
  } catch (err) {
    sendFallbackJson(req, res, 'GET /api/ad-providers/safe-policy', fallbackSafePolicy(), err);
  }
}

export async function getAdminSafeAdSettings(req, res) {
  try {
    const settings = await getSafeAdPolicySettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load safe ad settings' });
  }
}

export async function saveAdminSafeAdSettings(req, res) {
  try {
    const { settings } = req.body || {};
    if (!Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings array required' });
    }
    const forcedSettings = [
      { key: 'ad_safe_mode_strict', value: 'true' },
      { key: 'ad_allow_popups', value: 'false' },
      { key: 'ad_allow_redirects', value: 'false' },
      { key: 'ad_allow_floating', value: 'false' },
      { key: 'ad_block_aggressive', value: 'true' },
      { key: 'ad_block_interstitials', value: 'true' },
      { key: 'ad_block_click_hijacking', value: 'true' },
      { key: 'ad_dom_guard_enabled', value: 'true' },
      { key: 'ad_click_isolation', value: 'true' },
      { key: 'ad_safe_formats_only', value: 'true' },
      { key: 'ad_allowed_formats', value: '["banner","display","native","vast","video"]' },
      { key: 'ad_allowed_placements', value: '["video_preroll","feed","native_card","between_content","sidebar","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","homepage_banner","leaderboard","banner"]' },
      { key: 'ad_allowed_domains', value: SAFE_AD_DOMAINS_JSON },
      { key: 'ad_provider_priority_order', value: SAFE_PROVIDER_PRIORITY_JSON },
      { key: 'juicyads_script_url', value: SAFE_JUICY_SCRIPT_URL },
    ];
    const admin = req.adminUser || { name: req.admin?.email || 'Admin', id: req.admin?.id };
    const requested = new Map(settings.map((item) => [String(item.key), String(item.value ?? '')]));
    await saveAdminSettings(dedupeSettings([...settings, ...forcedSettings]), admin);
    if (requested.has('monetag_enabled')) {
      const enabled = requested.get('monetag_enabled') === 'true';
      const monetagPatch = {
        is_enabled: enabled,
        ...(enabled ? { is_maintenance: false } : {}),
      };
      if (requested.get('monetag_script_url')) {
        monetagPatch.script_url = APPROVED_MONETAG_SCRIPT_URL;
      }
      await updateProvider('monetag', monetagPatch, req.admin).catch(() => {});
    }
    invalidateConfigCache();
    invalidateSlotCache();
    res.json({ ok: true, message: 'Safe ad settings saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save safe ad settings' });
  }
}

export async function saveJuicyAdsSettings(req, res) {
  try {
    const { scriptUrl, zoneId, enabled, sidebarEnabled } = req.body;
    const updates = [];
    const safeScriptUrl = scriptUrl ? normalizeJuicyScriptUrl(scriptUrl) : '';
    if (scriptUrl) updates.push({ key: 'juicyads_script_url', value: safeScriptUrl });
    if (zoneId) updates.push({ key: 'juicyads_sidebar_zone_id', value: String(zoneId) });
    if (enabled !== undefined) updates.push({ key: 'juicyads_enabled', value: enabled ? 'true' : 'false' });
    if (sidebarEnabled !== undefined) updates.push({ key: 'sidebar_ads_enabled', value: sidebarEnabled ? 'true' : 'false' });

    if (scriptUrl || zoneId) {
      await updateProvider('juicyads', {
        script_url: safeScriptUrl || undefined,
        config: { defaultZoneId: zoneId, scriptUrl: safeScriptUrl, defaultWidth: 300, defaultHeight: 250 },
      }, req.admin);
    }

    for (const item of updates) {
      const { supabase } = await import('../config/supabase.js');
      if (supabase) {
        await supabase.from('platform_settings').upsert({ key: item.key, value: item.value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      }
    }

    invalidateSlotCache();
    invalidateConfigCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save JuicyAds settings' });
  }
}
