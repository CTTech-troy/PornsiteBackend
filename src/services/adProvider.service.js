import { supabase } from '../config/supabase.js';
import {
  APPROVED_MONETAG_SCRIPT_URL,
  APPROVED_MONETAG_ZONE_ID,
  getPublicSafeAdPolicy,
  isApprovedMonetagScriptUrl,
  validateMonetagPlacement,
} from './safeAdPolicy.service.js';

const CONFIG_CACHE_MS = 30_000;
let configCache = null;
let configCacheAt = 0;

const SAFE_PRIORITY = ['exoclick', 'juicyads', 'monetag', 'google_ad_manager'];
const LEGACY_SAFE_PRIORITY = ['monetag', 'juicyads', 'exoclick', 'google_ad_manager'];
const HARD_BLOCKED_PROVIDERS = new Set();
const BLOCKED_SCRIPT_PATTERN =
  /adserver\.juicyads\.com|popunder|clickunder|interstitial|popup|auto.?redirect|direct.?link|social.?bar|window\.open|top\.location|betway|casino|popads|popcash|propellerads|onclickads/i;
const QUGE5_HOST_PATTERN = /quge5\.com/i;
export const EXOCLICK_DISPLAY_SCRIPT_URL = 'https://a.magsrv.com/ad-provider.js';
export const EXOCLICK_DISPLAY_ZONE_ID = '5933054';
export const EXOCLICK_DISPLAY_INS_CLASS = 'eas6a97888e6';
export const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idz=5963164';
export const EXOCLICK_VAST_ZONE_ID = '5963164';
export const EXOCLICK_IN_VIDEO_BANNER_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idz=5964216';
export const EXOCLICK_IN_VIDEO_BANNER_ZONE_ID = '5964216';
const LEGACY_EXOCLICK_VAST_ZONE_IDS = new Set(['5932212', '5933056']);
const LEGACY_EXOCLICK_VAST_TAG_URLS = new Set([
  'https://s.magsrv.com/v1/vast.php?idz=5932212',
  'https://s.magsrv.com/v1/vast.php?idz=5933056',
  'https://s.magsrv.com/v1/vast.php?idzone=5932212',
  'https://s.magsrv.com/v1/vast.php?idzone=5933056',
]);
const EXOCLICK_DISPLAY_CONFIG = {
  insClass: EXOCLICK_DISPLAY_INS_CLASS,
  keywords: 'keywords',
  sub: '123450000',
  blockAdTypes: '0',
  exAv: 'name',
};
const EXOCLICK_DISPLAY_ZONE_SPECS = [
  { placement: 'leaderboard', width: 728, height: 90 },
  { placement: 'homepage_banner', width: 728, height: 90 },
  { placement: 'banner', width: 728, height: 90 },
  { placement: 'feed', width: 640, height: 360 },
  { placement: 'native_card', width: 640, height: 360 },
  { placement: 'between_content', width: 728, height: 90 },
  { placement: 'sidebar', width: 300, height: 250 },
  { placement: 'video_slider', width: 300, height: 250 },
];
const EXOCLICK_DISPLAY_PLACEMENTS = new Set(EXOCLICK_DISPLAY_ZONE_SPECS.map((z) => z.placement));
const CODE_MANAGED_AD_SETTINGS = Object.freeze({
  ad_auto_fallback_enabled: 'true',
  ad_revenue_enabled: 'true',
  google_ad_manager_enabled: 'false',
  juicyads_enabled: 'true',
  juicyads_script_url: 'https://poweredby.jads.co/js/jads.js',
  juicyads_sidebar_zone_id: '1118510',
  monetag_enabled: 'true',
  monetag_native_enabled: 'true',
  monetag_sidebar_enabled: 'true',
  monetag_banner_enabled: 'true',
  monetag_script_url: APPROVED_MONETAG_SCRIPT_URL,
  monetag_native_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_sidebar_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_banner_zone_id: APPROVED_MONETAG_ZONE_ID,
  vast_ad_timeout_sec: '5',
  vast_skip_after_seconds_default: '5',
  vast_estimated_cpm_usd: '2',
  vast_in_video_banner_enabled: 'true',
  vast_in_video_banner_tag_url: EXOCLICK_IN_VIDEO_BANNER_VAST_TAG_URL,
  vast_in_video_banner_triggers: JSON.stringify({
    preroll: true,
    pause: true,
    postroll: true,
    custom: true,
  }),
  vast_in_video_banner_alignment: 'bottom',
  vast_in_video_banner_mobile_alignment: 'bottom',
  vast_in_video_banner_size_preference: 'auto',
  vast_in_video_banner_auto_hide_ms: '12000',
  vast_in_video_banner_pause_auto_hide_ms: '0',
  vast_in_video_banner_postroll_auto_hide_ms: '0',
  vast_in_video_banner_retry_limit: '1',
  vast_in_video_banner_retry_delay_ms: '750',
  vast_in_video_banner_refresh_interval_ms: '0',
  vast_in_video_banner_hide_in_fullscreen: 'false',
  vast_in_video_banner_leaderboard_min_width: '760',
});

function codeManagedAdsError() {
  const err = new Error('Ad configuration is managed manually in the codebase.');
  err.status = 410;
  err.code = 'ADS_MANAGED_IN_CODE';
  return err;
}

function isMissingTable(err) {
  const msg = String(err?.message || err?.code || '');
  return (
    msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    err?.code === 'PGRST204' ||
    err?.code === 'PGRST205'
  );
}

export async function listProviders() {
  return getDefaultProviders();
}

export async function getProviderById(id) {
  const providers = await listProviders();
  return providers.find((p) => p.id === id) || null;
}

export async function updateProvider(id, patch, admin = null) {
  throw codeManagedAdsError();
}

export async function listZones(providerId = null) {
  return getDefaultZones(providerId);
}

export async function upsertZone(zone, admin = null) {
  throw codeManagedAdsError();
}

export async function deleteZone(id, admin = null) {
  throw codeManagedAdsError();
}

export async function getPriorityOrder() {
  return SAFE_PRIORITY;
}

export async function savePriorityOrder(order, admin = null) {
  throw codeManagedAdsError();
}

function resolveSafeMonetagScriptUrl(url) {
  const value = String(url || '').trim();
  if (!value) return APPROVED_MONETAG_SCRIPT_URL;
  if (isApprovedMonetagScriptUrl(value)) return APPROVED_MONETAG_SCRIPT_URL;
  return APPROVED_MONETAG_SCRIPT_URL;
}

function samePriorityOrder(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveSafeExoClickDisplayScriptUrl(url) {
  const value = String(url || '').trim();
  if (!value) return EXOCLICK_DISPLAY_SCRIPT_URL;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'a.magsrv.com' &&
      parsed.pathname === '/ad-provider.js'
    ) {
      return parsed.toString();
    }
  } catch {
    /* use approved default */
  }
  return EXOCLICK_DISPLAY_SCRIPT_URL;
}

function isAllowedPublicAdUrl(url, allowedDomains = []) {
  if (!url) return true;
  if (BLOCKED_SCRIPT_PATTERN.test(String(url).toLowerCase()) || QUGE5_HOST_PATTERN.test(String(url).toLowerCase())) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (allowedDomains || []).some((domain) => {
      const d = String(domain || '').toLowerCase();
      return host === d || host.endsWith(`.${d}`);
    });
  } catch {
    return false;
  }
}

function settingsBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function settingsNumber(value, fallback, min = null, max = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const withMin = min == null ? numeric : Math.max(min, numeric);
  return max == null ? withMin : Math.min(max, withMin);
}

function settingsJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function normalizeExoClickZone(zone) {
  if (!zone) return zone;
  if (zone.placement === 'video_preroll') {
    const zoneId = String(zone.zone_id || zone.zoneId || '');
    const tagUrl = String(zone.tag_url || zone.tagUrl || '');
    if (LEGACY_EXOCLICK_VAST_ZONE_IDS.has(zoneId) || LEGACY_EXOCLICK_VAST_TAG_URLS.has(tagUrl)) {
      return {
        ...zone,
        zone_id: EXOCLICK_VAST_ZONE_ID,
        tag_url: EXOCLICK_VAST_TAG_URL,
      };
    }
    return zone;
  }
  if (!EXOCLICK_DISPLAY_PLACEMENTS.has(zone.placement)) return zone;
  return {
    ...zone,
    tag_url: resolveSafeExoClickDisplayScriptUrl(zone.tag_url),
    config: {
      ...EXOCLICK_DISPLAY_CONFIG,
      ...(zone.config || {}),
    },
  };
}

export async function resolveActiveProviders({ type = null, placement = null } = {}) {
  const [providers, zones, priority] = await Promise.all([
    listProviders(),
    listZones(),
    getPriorityOrder(),
  ]);

  const settings = CODE_MANAGED_AD_SETTINGS;
  const autoFallback = true;
  const enabledSlugs = {
    juicyads: settings.juicyads_enabled !== 'false',
    monetag: settings.monetag_enabled === 'true',
    google_ad_manager: settings.google_ad_manager_enabled === 'true',
    exoclick: settings.ad_revenue_enabled !== 'false',
  };

  const filtered = providers
    .filter((p) => p.is_enabled && !p.is_maintenance && enabledSlugs[p.slug] !== false)
    .filter((p) => !HARD_BLOCKED_PROVIDERS.has(String(p.slug || '').toLowerCase()))
    .filter((p) => !type || p.provider_type === type)
    .sort((a, b) => {
      const ai = priority.indexOf(a.slug);
      const bi = priority.indexOf(b.slug);
      const ar = ai === -1 ? a.priority : ai;
      const br = bi === -1 ? b.priority : bi;
      return ar - br;
    })
    .map((p) => ({
      ...p,
      zones: zones.filter((z) => z.provider_id === p.id && z.is_active && (!placement || z.placement === placement)),
    }))
    .filter((p) => !placement || p.zones.length > 0 || p.provider_type === 'vast');

  return { providers: filtered, autoFallback, priority, settings };
}

export async function getPublicAdConfig() {
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_CACHE_MS) return configCache;

  const settings = CODE_MANAGED_AD_SETTINGS;
  const resolved = await resolveActiveProviders();
  const safePolicy = await getPublicSafeAdPolicy();
  const juicyScript = settings.juicyads_script_url || 'https://poweredby.jads.co/js/jads.js';
  const safeJuicyScript = (BLOCKED_SCRIPT_PATTERN.test(juicyScript.toLowerCase()) || QUGE5_HOST_PATTERN.test(juicyScript.toLowerCase()))
    ? 'https://poweredby.jads.co/js/jads.js'
    : juicyScript;
  const approvedPlacements = new Set(safePolicy.approvedPlacements || []);
  const monetagVirtualZones = [
    (settings.monetag_native_zone_id || APPROVED_MONETAG_ZONE_ID) ? { placement: 'feed', zone_id: settings.monetag_native_zone_id || APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 640, height: 360, is_active: true } : null,
    (settings.monetag_sidebar_zone_id || APPROVED_MONETAG_ZONE_ID) ? { placement: 'sidebar', zone_id: settings.monetag_sidebar_zone_id || APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 300, height: 250, is_active: true } : null,
    (settings.monetag_banner_zone_id || APPROVED_MONETAG_ZONE_ID) ? { placement: 'leaderboard', zone_id: settings.monetag_banner_zone_id || APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 728, height: 90, is_active: true } : null,
  ].filter(Boolean);
  const isSafeZone = (provider, zone) => {
    if (!zone?.placement || !approvedPlacements.has(zone.placement)) return false;
    const slug = String(provider.slug || '').toLowerCase();
    if (slug === 'exoclick') {
      if (zone.placement === 'video_preroll') return true;
      if (!EXOCLICK_DISPLAY_PLACEMENTS.has(zone.placement)) return false;
      return isAllowedPublicAdUrl(zone.tag_url || provider.script_url || EXOCLICK_DISPLAY_SCRIPT_URL, safePolicy.allowedDomains);
    }
    if (slug === 'juicyads') return zone.placement !== 'video_preroll';
    if (slug === 'monetag') {
      if (settings.monetag_enabled !== 'true') return false;
      const format = ['feed', 'native_card', 'between_content'].includes(zone.placement) ? 'native' : 'banner';
      const placement = validateMonetagPlacement(zone.placement, format);
      if (!placement.ok) return false;
      if (placement.kind === 'native' && settings.monetag_native_enabled !== 'true') return false;
      if (placement.kind === 'sidebar' && settings.monetag_sidebar_enabled !== 'true') return false;
      if (placement.kind === 'banner' && settings.monetag_banner_enabled !== 'true') return false;
      if (zone.tag_url && !isApprovedMonetagScriptUrl(zone.tag_url) && (BLOCKED_SCRIPT_PATTERN.test(String(zone.tag_url).toLowerCase()) || QUGE5_HOST_PATTERN.test(String(zone.tag_url).toLowerCase()))) return false;
      return true;
    }
    if (slug === 'google_ad_manager') return zone.placement !== 'video_preroll';
    return false;
  };
  const publicProviders = resolved.providers
    .filter((p) => !HARD_BLOCKED_PROVIDERS.has(String(p.slug || '').toLowerCase()))
    .map((p) => {
      const candidateZones = p.slug === 'monetag'
        ? [...(p.zones || []), ...monetagVirtualZones]
        : p.slug === 'exoclick'
          ? (p.zones || []).map(normalizeExoClickZone)
          : (p.zones || []);
      const seen = new Set();
      const zonesForProvider = candidateZones.filter((z) => {
        const key = `${z.placement}:${z.zone_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...p, zones: zonesForProvider.filter((z) => isSafeZone(p, z)) };
    })
    .filter((p) => p.provider_type === 'vast' || p.zones.length > 0);

  configCache = {
    priority: resolved.priority.filter((slug) => !HARD_BLOCKED_PROVIDERS.has(slug)),
    autoFallback: resolved.autoFallback,
    providers: publicProviders.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: p.slug === 'exoclick' && (p.zones || []).some((z) => z.placement !== 'video_preroll') ? 'display' : p.provider_type,
      allowedFormats: safePolicy.safeDisplayFormats || [],
      blockedFormats: safePolicy.blockedFormats || [],
      scriptUrl: p.slug === 'juicyads'
        ? safeJuicyScript
        : p.slug === 'monetag'
          ? resolveSafeMonetagScriptUrl(p.script_url || settings.monetag_script_url)
          : p.slug === 'exoclick' && (p.zones || []).some((z) => z.placement !== 'video_preroll')
            ? EXOCLICK_DISPLAY_SCRIPT_URL
          : p.script_url,
      config: p.slug === 'exoclick'
        ? { ...EXOCLICK_DISPLAY_CONFIG, ...(p.config || {}) }
        : (p.config || {}),
      skipAfterSeconds: p.skip_after_seconds,
      skippable: p.skippable,
      adFrequency: p.ad_frequency,
      timeoutMs: p.timeout_ms,
      retryLimit: p.retry_limit,
      zones: (p.zones || []).map((z) => ({
        placement: z.placement,
        zoneId: z.zone_id,
        tagUrl: z.tag_url,
        width: z.width,
        height: z.height,
        config: z.config || {},
      })),
    })),
    vast: {
      timeoutSec: Number(settings.vast_ad_timeout_sec || 5),
      skipAfterSeconds: Number(settings.vast_skip_after_seconds_default || 5),
      estimatedCpmUsd: Number(settings.vast_estimated_cpm_usd || 2),
      inVideoBanner: {
        enabled: settingsBoolean(settings.vast_in_video_banner_enabled, true),
        vastTagUrl: settings.vast_in_video_banner_tag_url || EXOCLICK_IN_VIDEO_BANNER_VAST_TAG_URL,
        zoneId: EXOCLICK_IN_VIDEO_BANNER_ZONE_ID,
        triggers: settingsJson(settings.vast_in_video_banner_triggers, {
          preroll: true,
          pause: true,
          postroll: true,
          custom: true,
        }),
        verticalAlignment: settings.vast_in_video_banner_alignment || 'bottom',
        mobileVerticalAlignment: settings.vast_in_video_banner_mobile_alignment || 'bottom',
        sizePreference: settings.vast_in_video_banner_size_preference || 'auto',
        timeoutMs: settingsNumber(settings.vast_ad_timeout_sec, 5, 1, 15) * 1000,
        retry: {
          enabled: true,
          maxRetries: Math.round(settingsNumber(settings.vast_in_video_banner_retry_limit, 1, 0, 1)),
          delayMs: settingsNumber(settings.vast_in_video_banner_retry_delay_ms, 750, 250, 2000),
        },
        autoHide: {
          enabled: true,
          ms: settingsNumber(settings.vast_in_video_banner_auto_hide_ms, 12000, 0, 60000),
          pauseMs: settingsNumber(settings.vast_in_video_banner_pause_auto_hide_ms, 0, 0, 60000),
          postrollMs: settingsNumber(settings.vast_in_video_banner_postroll_auto_hide_ms, 0, 0, 60000),
        },
        refreshIntervalMs: settingsNumber(settings.vast_in_video_banner_refresh_interval_ms, 0, 0, 300000),
        hideInFullscreen: settingsBoolean(settings.vast_in_video_banner_hide_in_fullscreen, false),
        breakpoints: {
          mobileMaxWidth: 767,
          leaderboardMinWidth: settingsNumber(settings.vast_in_video_banner_leaderboard_min_width, 760, 320, 1600),
        },
        sizes: [
          { key: 'leaderboard', width: 728, height: 90 },
          { key: 'mpu', width: 300, height: 250 },
        ],
      },
    },
    safePolicy,
  };
  configCacheAt = now;
  return configCache;
}

export function invalidateConfigCache() {
  configCache = null;
  configCacheAt = 0;
}

export async function incrementProviderStats(providerId, { impressions = 0, clicks = 0, failed = 0, revenueUsd = 0, success = null } = {}) {
  if (!supabase || !providerId) return;
  const patch = {};
  if (impressions) patch.impressions = supabase.rpc ? undefined : undefined;
  const { data: current, error: currentError } = await supabase.from('ad_providers').select('impressions,clicks,failed_requests,revenue_usd').eq('id', providerId).maybeSingle();
  if (currentError) {
    if (!isMissingTable(currentError)) throw currentError;
    return;
  }
  if (!current) return;
  const update = {
    impressions: Number(current.impressions || 0) + impressions,
    clicks: Number(current.clicks || 0) + clicks,
    failed_requests: Number(current.failed_requests || 0) + failed,
    revenue_usd: Number(current.revenue_usd || 0) + revenueUsd,
    updated_at: new Date().toISOString(),
  };
  if (success === true) update.last_success_at = new Date().toISOString();
  if (success === false) update.last_failure_at = new Date().toISOString();
  const { error } = await supabase.from('ad_providers').update(update).eq('id', providerId);
  if (error && !isMissingTable(error)) throw error;
}

async function logAudit({ providerId, admin, action, before, after }) {
  if (!supabase) return;
  const { error } = await supabase.from('ad_provider_audit_log').insert({
    provider_id: providerId,
    admin_id: admin?.id || null,
    admin_email: admin?.email || null,
    action,
    before_state: before,
    after_state: after,
  });
  if (error && !isMissingTable(error)) throw error;
}

export async function getAuditLog(limit = 50) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('ad_provider_audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

function getDefaultProviders() {
  return [
    { id: 'exoclick', name: 'ExoClick', slug: 'exoclick', provider_type: 'vast', is_enabled: true, is_maintenance: false, priority: 10, script_url: null, config: { displayScriptUrl: EXOCLICK_DISPLAY_SCRIPT_URL, displayZoneId: EXOCLICK_DISPLAY_ZONE_ID, vastZoneId: EXOCLICK_VAST_ZONE_ID, vastTagUrl: EXOCLICK_VAST_TAG_URL, ...EXOCLICK_DISPLAY_CONFIG }, estimated_cpm_usd: 2, skip_after_seconds: 5, skippable: true, ad_frequency: 3, retry_limit: 2, timeout_ms: 5000, last_health_status: 'unknown', impressions: 0, clicks: 0, failed_requests: 0, revenue_usd: 0 },
    { id: 'juicyads', name: 'JuicyAds', slug: 'juicyads', provider_type: 'display', is_enabled: true, is_maintenance: false, priority: 20, script_url: 'https://poweredby.jads.co/js/jads.js', config: { queueKey: 'adsbyjuicy', defaultZoneId: '1118510', defaultWidth: 300, defaultHeight: 250 }, estimated_cpm_usd: 1.5, skip_after_seconds: 5, skippable: true, ad_frequency: 3, retry_limit: 2, timeout_ms: 8000, last_health_status: 'unknown', impressions: 0, clicks: 0, failed_requests: 0, revenue_usd: 0 },
    { id: 'monetag', name: 'Monetag', slug: 'monetag', provider_type: 'display', is_enabled: true, is_maintenance: false, priority: 30, script_url: APPROVED_MONETAG_SCRIPT_URL, config: { safeMode: true, sandboxed: true, allowedFormats: ['native', 'banner', 'display'] }, estimated_cpm_usd: 1.2, skip_after_seconds: 5, skippable: true, ad_frequency: 3, retry_limit: 2, timeout_ms: 8000, last_health_status: 'unknown', impressions: 0, clicks: 0, failed_requests: 0, revenue_usd: 0 },
    { id: 'google_ad_manager', name: 'Google Ad Manager', slug: 'google_ad_manager', provider_type: 'gam', is_enabled: false, is_maintenance: false, priority: 40, script_url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', config: {}, estimated_cpm_usd: 3, skip_after_seconds: 5, skippable: true, ad_frequency: 3, retry_limit: 2, timeout_ms: 8000, last_health_status: 'unknown', impressions: 0, clicks: 0, failed_requests: 0, revenue_usd: 0 },
  ];
}

function mergeBuiltinProviders(providers) {
  const byId = new Map((providers || []).map((p) => [p.id, p]));
  for (const def of getDefaultProviders()) {
    if (!byId.has(def.id)) byId.set(def.id, def);
  }
  return [...byId.values()].sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
}

function mergeBuiltinZones(zones, providerId = null) {
  const byKey = new Map();
  const merged = [];
  const addZone = (zone) => {
    const key = `${zone.provider_id}:${zone.placement}:${zone.zone_id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, zone);
      merged.push(zone);
      return;
    }
    if (existing.is_active === false && zone.is_active !== false) {
      byKey.set(key, zone);
      const idx = merged.indexOf(existing);
      if (idx >= 0) merged[idx] = zone;
    }
  };
  for (const zone of zones || []) {
    const normalized = zone.provider_id === 'exoclick' ? normalizeExoClickZone(zone) : zone;
    addZone(normalized);
  }
  for (const zone of getDefaultZones(providerId)) {
    addZone(zone);
  }
  return merged.sort((a, b) => {
    const ap = `${a.provider_id}:${a.placement}:${a.zone_id}`;
    const bp = `${b.provider_id}:${b.placement}:${b.zone_id}`;
    return ap.localeCompare(bp);
  });
}

function getDefaultZones(providerId = null) {
  const zones = [
    { id: 'default-exo', provider_id: 'exoclick', placement: 'video_preroll', zone_id: EXOCLICK_VAST_ZONE_ID, tag_url: EXOCLICK_VAST_TAG_URL, width: null, height: null, is_active: true },
    ...EXOCLICK_DISPLAY_ZONE_SPECS.map((spec) => ({
      id: `default-exo-${spec.placement}`,
      provider_id: 'exoclick',
      placement: spec.placement,
      zone_id: EXOCLICK_DISPLAY_ZONE_ID,
      tag_url: EXOCLICK_DISPLAY_SCRIPT_URL,
      width: spec.width,
      height: spec.height,
      is_active: true,
      config: EXOCLICK_DISPLAY_CONFIG,
    })),
    { id: 'default-juicy-sidebar', provider_id: 'juicyads', placement: 'sidebar', zone_id: '1118510', tag_url: null, width: 300, height: 250, is_active: true },
    { id: 'default-monetag-feed', provider_id: 'monetag', placement: 'feed', zone_id: APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 640, height: 360, is_active: true },
    { id: 'default-monetag-sidebar', provider_id: 'monetag', placement: 'sidebar', zone_id: APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 300, height: 250, is_active: true },
    { id: 'default-monetag-banner', provider_id: 'monetag', placement: 'leaderboard', zone_id: APPROVED_MONETAG_ZONE_ID, tag_url: null, width: 728, height: 90, is_active: true },
  ];
  return providerId ? zones.filter((z) => z.provider_id === providerId) : zones;
}
