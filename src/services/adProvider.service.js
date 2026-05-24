import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';
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
export const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idzone=5933056';
export const EXOCLICK_VAST_ZONE_ID = '5933056';
const LEGACY_EXOCLICK_VAST_ZONE_ID = '5932212';
const LEGACY_EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idzone=5932212';
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
];
const EXOCLICK_DISPLAY_PLACEMENTS = new Set(EXOCLICK_DISPLAY_ZONE_SPECS.map((z) => z.placement));

function isMissingTable(err) {
  const msg = String(err?.message || err?.code || '');
  return msg.includes('does not exist') || err?.code === '42P01' || err?.code === 'PGRST205';
}

export async function listProviders() {
  if (!supabase) return getDefaultProviders();
  const { data, error } = await supabase
    .from('ad_providers')
    .select('*')
    .order('priority', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return getDefaultProviders();
    throw error;
  }
  return data?.length ? mergeBuiltinProviders(data) : getDefaultProviders();
}

export async function getProviderById(id) {
  const providers = await listProviders();
  return providers.find((p) => p.id === id) || null;
}

export async function updateProvider(id, patch, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const before = await getProviderById(id);
  const payload = {
  ...patch,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('ad_providers')
    .update(payload)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const builtIn = getDefaultProviders().find((p) => p.id === id);
    if (builtIn) {
      const { data: inserted, error: upsertError } = await supabase
        .from('ad_providers')
        .upsert({ ...builtIn, ...payload }, { onConflict: 'id' })
        .select('*')
        .maybeSingle();
      if (upsertError) throw upsertError;
      await logAudit({
        providerId: id,
        admin,
        action: 'upsert_provider',
        before,
        after: inserted,
      });
      invalidateConfigCache();
      return inserted;
    }
  }
  await logAudit({
    providerId: id,
    admin,
    action: 'update_provider',
    before,
    after: data,
  });
  invalidateConfigCache();
  return data;
}

export async function listZones(providerId = null) {
  if (!supabase) return getDefaultZones(providerId);
  let query = supabase.from('ad_zones').select('*').order('placement');
  if (providerId) query = query.eq('provider_id', providerId);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return getDefaultZones(providerId);
    throw error;
  }
  return mergeBuiltinZones(data || [], providerId);
}

export async function upsertZone(zone, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const row = {
    provider_id: zone.provider_id,
    placement: zone.placement,
    zone_id: zone.zone_id,
    tag_url: zone.tag_url || null,
    width: zone.width ?? null,
    height: zone.height ?? null,
    is_active: zone.is_active !== false,
    config: zone.config || {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('ad_zones')
    .upsert(row, { onConflict: 'provider_id,placement,zone_id' })
    .select('*')
    .maybeSingle();
  if (error) throw error;
  await logAudit({
    providerId: zone.provider_id,
    admin,
    action: zone.id ? 'update_zone' : 'create_zone',
    before: null,
    after: data,
  });
  invalidateConfigCache();
  return data;
}

export async function deleteZone(id, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const { data: before } = await supabase.from('ad_zones').select('*').eq('id', id).maybeSingle();
  const { error } = await supabase.from('ad_zones').delete().eq('id', id);
  if (error) throw error;
  await logAudit({
    providerId: before?.provider_id,
    admin,
    action: 'delete_zone',
    before,
    after: null,
  });
  invalidateConfigCache();
}

export async function getPriorityOrder() {
  const settings = await getPlatformSettingsMap();
  try {
    const parsed = JSON.parse(settings.ad_provider_priority_order || '[]');
    if (Array.isArray(parsed) && parsed.length) {
      const order = parsed.map(String).filter((slug) => !HARD_BLOCKED_PROVIDERS.has(slug));
      if (samePriorityOrder(order, LEGACY_SAFE_PRIORITY)) return SAFE_PRIORITY;
      return order;
    }
  } catch { /* ignore */ }
  return SAFE_PRIORITY;
}

export async function savePriorityOrder(order, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const value = JSON.stringify((Array.isArray(order) ? order : []).map(String).filter((slug) => !HARD_BLOCKED_PROVIDERS.has(slug)));
  const { error } = await supabase
    .from('platform_settings')
    .upsert({ key: 'ad_provider_priority_order', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
  await logAudit({
    providerId: null,
    admin,
    action: 'update_priority_order',
    before: null,
    after: { order: value },
  });
  invalidateConfigCache();
  return value;
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

function normalizeExoClickZone(zone) {
  if (!zone) return zone;
  if (zone.placement === 'video_preroll') {
    const zoneId = String(zone.zone_id || zone.zoneId || '');
    const tagUrl = String(zone.tag_url || zone.tagUrl || '');
    if (zoneId === LEGACY_EXOCLICK_VAST_ZONE_ID || tagUrl === LEGACY_EXOCLICK_VAST_TAG_URL) {
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
  const [providers, zones, settings, priority] = await Promise.all([
    listProviders(),
    listZones(),
    getPlatformSettingsMap(),
    getPriorityOrder(),
  ]);

  const autoFallback = settings.ad_auto_fallback_enabled !== 'false';
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

  const settings = await getPlatformSettingsMap();
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
      timeoutSec: Number(settings.vast_ad_timeout_sec || 8),
      skipAfterSeconds: Number(settings.vast_skip_after_seconds_default || 5),
      estimatedCpmUsd: Number(settings.vast_estimated_cpm_usd || 2),
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
  const { data: current } = await supabase.from('ad_providers').select('impressions,clicks,failed_requests,revenue_usd').eq('id', providerId).maybeSingle();
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
  await supabase.from('ad_providers').update(update).eq('id', providerId);
}

async function logAudit({ providerId, admin, action, before, after }) {
  if (!supabase) return;
  await supabase.from('ad_provider_audit_log').insert({
    provider_id: providerId,
    admin_id: admin?.id || null,
    admin_email: admin?.email || null,
    action,
    before_state: before,
    after_state: after,
  });
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
    { id: 'exoclick', name: 'ExoClick', slug: 'exoclick', provider_type: 'vast', is_enabled: true, is_maintenance: false, priority: 10, script_url: null, config: { displayScriptUrl: EXOCLICK_DISPLAY_SCRIPT_URL, displayZoneId: EXOCLICK_DISPLAY_ZONE_ID, ...EXOCLICK_DISPLAY_CONFIG }, estimated_cpm_usd: 2, skip_after_seconds: 5, skippable: true, ad_frequency: 3, retry_limit: 2, timeout_ms: 8000, last_health_status: 'unknown', impressions: 0, clicks: 0, failed_requests: 0, revenue_usd: 0 },
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
