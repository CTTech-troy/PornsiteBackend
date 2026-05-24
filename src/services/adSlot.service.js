import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';
import {
  EXOCLICK_DISPLAY_SCRIPT_URL,
  EXOCLICK_DISPLAY_ZONE_ID,
  getPublicAdConfig,
  invalidateConfigCache,
} from './adProvider.service.js';
import { APPROVED_MONETAG_SCRIPT_URL, APPROVED_MONETAG_ZONE_ID } from './safeAdPolicy.service.js';

const SLOT_CACHE_MS = 30_000;
let slotCache = null;
let slotCacheAt = 0;

const PAGE_ALIASES = {
  home: ['home', 'homepage', 'main'],
  video: ['video', 'video_detail', 'watch'],
  creator: ['creator'],
  live: ['live', 'live_streams'],
  feed: ['feed'],
  search: ['search'],
  random: ['random', 'random_1v1'],
  dashboard: ['dashboard', 'user_dashboard'],
  studio: ['studio', 'creator_studio'],
};

function isMissingTable(err) {
  const msg = String(err?.message || err?.code || '');
  return msg.includes('does not exist') || err?.code === '42P01' || err?.code === 'PGRST205';
}

function slotPlacementKey(slot) {
  if (slot.page === 'video' && slot.location === 'recommended') return 'video_recommended';
  if (slot.page === 'video') return 'video_sidebar';
  if (slot.page === 'creator') return 'creator_sidebar';
  if (slot.page === 'live') return 'live_sidebar';
  if (slot.page === 'feed') return 'feed_sidebar';
  if (slot.page === 'search') return 'sidebar';
  return 'sidebar';
}

function parseJsonList(raw, fallback = []) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function slotKind(slot) {
  const placement = slotPlacementKey(slot);
  if (['feed', 'native_card', 'between_content'].includes(placement)) return 'native';
  if (['homepage_banner', 'leaderboard', 'banner'].includes(placement)) return 'banner';
  return 'sidebar';
}

function defaultMonetagZoneId(settings, kind) {
  if (kind === 'native') return settings.monetag_native_zone_id || '';
  if (kind === 'banner') return settings.monetag_banner_zone_id || '';
  return settings.monetag_sidebar_zone_id || '';
}

function isMonetagSlotAllowed(slot, settings) {
  if (settings.monetag_enabled !== 'true') return false;
  const kind = slotKind(slot);
  if (kind === 'native' && settings.monetag_native_enabled !== 'true') return false;
  if (kind === 'sidebar' && settings.monetag_sidebar_enabled !== 'true') return false;
  if (kind === 'banner' && settings.monetag_banner_enabled !== 'true') return false;
  const pages = parseJsonList(settings.monetag_allowed_pages, ['home', 'video', 'creator', 'feed', 'search', 'live']).map(String);
  const slots = parseJsonList(settings.monetag_allowed_slots, []).map(String);
  if (pages.length && !pages.includes(String(slot.page))) return false;
  if (slots.length && !slots.includes(String(slot.slot_key))) return false;
  return Boolean(slot.zone_id || defaultMonetagZoneId(settings, kind));
}

function providerThirdPartyEnabled(slot, settings, globalThirdPartyEnabled) {
  if (!globalThirdPartyEnabled || slot.third_party_enabled === false) return false;
  const provider = String(slot.provider_id || 'juicyads').toLowerCase();
  if (provider === 'monetag') return isMonetagSlotAllowed(slot, settings);
  if (provider === 'exoclick') return settings.ad_revenue_enabled !== 'false';
  if (provider === 'juicyads') return settings.juicyads_enabled !== 'false';
  if (provider === 'google_ad_manager') return settings.google_ad_manager_enabled === 'true';
  return false;
}

function isScheduled(slot) {
  const now = Date.now();
  if (slot.schedule_start && new Date(slot.schedule_start).getTime() > now) return false;
  if (slot.schedule_end && new Date(slot.schedule_end).getTime() < now) return false;
  return true;
}

function isSafeSidebarSlot(slot) {
  const location = String(slot.location || 'sidebar').toLowerCase();
  const width = Number(slot.width) || 300;
  const height = Number(slot.height) || 250;
  return ['sidebar', 'recommended'].includes(location) && width <= 336 && height <= 600;
}

export async function listAdSlots() {
  if (!supabase) return getDefaultSlots();
  const { data, error } = await supabase.from('ad_slots').select('*').order('priority');
  if (error) {
    if (isMissingTable(error)) return getDefaultSlots();
    throw error;
  }
  return data?.length ? data : getDefaultSlots();
}

export async function getAdSlotByKey(slotKey) {
  const slots = await listAdSlots();
  return slots.find((s) => s.slot_key === slotKey) || null;
}

export async function upsertAdSlot(slot, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const row = {
    slot_key: slot.slot_key,
    name: slot.name,
    page: slot.page,
    location: ['sidebar', 'recommended'].includes(String(slot.location || 'sidebar').toLowerCase())
      ? String(slot.location || 'sidebar').toLowerCase()
      : 'sidebar',
    width: Math.min(Number(slot.width) || 300, 336),
    height: Math.min(Number(slot.height) || 250, 600),
    size_label: `${Math.min(Number(slot.width) || 300, 336)}x${Math.min(Number(slot.height) || 250, 600)}`,
    provider_type: slot.provider_type || 'mixed',
    provider_id: ['juicyads', 'monetag', 'exoclick', 'google_ad_manager'].includes(String(slot.provider_id || '').toLowerCase())
      ? String(slot.provider_id).toLowerCase()
      : (slot.provider_id || 'juicyads'),
    zone_id: slot.zone_id || null,
    embed_code: slot.embed_code || null,
    custom_enabled: slot.custom_enabled !== false,
    third_party_enabled: slot.third_party_enabled !== false,
    display_mode: slot.display_mode || 'custom_first',
    is_active: slot.is_active !== false,
    priority: Number(slot.priority) || 100,
    device_target: slot.device_target || 'desktop',
    frequency_cap: Number(slot.frequency_cap) || 0,
    schedule_start: slot.schedule_start || null,
    schedule_end: slot.schedule_end || null,
    config: slot.config || {},
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('ad_slots')
    .upsert(row, { onConflict: 'slot_key' })
    .select('*')
    .maybeSingle();
  if (error) throw error;

  await supabase.from('ad_provider_audit_log').insert({
    provider_id: slot.provider_id || 'juicyads',
    admin_id: admin?.id || null,
    admin_email: admin?.email || null,
    action: 'upsert_ad_slot',
    after_state: data,
  });

  invalidateSlotCache();
  invalidateConfigCache();
  return data;
}

export async function patchAdSlot(slotKey, patch, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const before = await getAdSlotByKey(slotKey);
  const { data, error } = await supabase
    .from('ad_slots')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('slot_key', slotKey)
    .select('*')
    .maybeSingle();
  if (error) throw error;

  await supabase.from('ad_provider_audit_log').insert({
    provider_id: data?.provider_id,
    admin_id: admin?.id || null,
    admin_email: admin?.email || null,
    action: 'patch_ad_slot',
    before_state: before,
    after_state: data,
  });

  invalidateSlotCache();
  invalidateConfigCache();
  return data;
}

export async function deleteAdSlot(slotKey, admin = null) {
  if (!supabase) throw new Error('Database unavailable');
  const before = await getAdSlotByKey(slotKey);
  const { error } = await supabase.from('ad_slots').delete().eq('slot_key', slotKey);
  if (error) throw error;
  await supabase.from('ad_provider_audit_log').insert({
    admin_id: admin?.id || null,
    admin_email: admin?.email || null,
    action: 'delete_ad_slot',
    before_state: before,
  });
  invalidateSlotCache();
}

export function invalidateSlotCache() {
  slotCache = null;
  slotCacheAt = 0;
}

export async function getPublicSlotsConfig({ page = null, device = 'desktop' } = {}) {
  const now = Date.now();
  if (!page && slotCache && now - slotCacheAt < SLOT_CACHE_MS) return slotCache;

  const [settings, slots, providerConfig] = await Promise.all([
    getPlatformSettingsMap(),
    listAdSlots(),
    getPublicAdConfig(),
  ]);

  const globalEnabled = settings.sidebar_ads_enabled !== 'false';
  const customEnabled = settings.sidebar_custom_ads_enabled !== 'false';
  const thirdPartyEnabled = settings.sidebar_third_party_enabled !== 'false';
  const juicyZoneId = settings.juicyads_sidebar_zone_id || '1118510';
  const storedJuicyScriptUrl = settings.juicyads_script_url || 'https://poweredby.jads.co/js/jads.js';
  const juicyScriptUrl = /quge5\.com|monetag|adserver\.juicyads\.com|popunder|clickunder|interstitial|betway/i.test(storedJuicyScriptUrl)
    ? 'https://poweredby.jads.co/js/jads.js'
    : storedJuicyScriptUrl;

  const juicyProvider = (providerConfig.providers || []).find((p) => p.slug === 'juicyads');
  const monetagProvider = (providerConfig.providers || []).find((p) => p.slug === 'monetag');
  const exoClickProvider = (providerConfig.providers || []).find((p) => p.slug === 'exoclick');
  const exoClickSidebarZone = exoClickProvider?.zones?.find((z) => z.placement === 'sidebar')
    || exoClickProvider?.zones?.find((z) => z.placement === 'home_sidebar')
    || null;
  const monetagAllowedDomains = parseJsonList(settings.monetag_allowed_domains, [
    'quge5.com',
    'monetag.com',
    'www.monetag.com',
    'highperformanceformat.com',
    'profitablecpmrate.com',
    'profitablecpmgate.com',
    'alwingulla.com',
  ]).map(String);

  let active = slots
    .filter((s) => s.is_active && isScheduled(s))
    .filter(isSafeSidebarSlot)
    .filter((s) => {
      if (s.device_target === 'all') return true;
      if (s.device_target === 'desktop') return device === 'desktop';
      if (s.device_target === 'tablet') return device === 'tablet' || device === 'desktop';
      if (s.device_target === 'mobile') return device === 'mobile';
      return true;
    });

  if (page) {
    const aliases = PAGE_ALIASES[page] || [page];
    active = active.filter((s) => aliases.includes(s.page) || s.page === page);
  }

  const payload = {
    enabled: globalEnabled,
    customEnabled,
    thirdPartyEnabled,
    juicyAds: {
      enabled: settings.juicyads_enabled !== 'false' && thirdPartyEnabled,
      scriptUrl: juicyProvider?.scriptUrl || juicyScriptUrl,
      zoneId: juicyZoneId,
      width: 300,
      height: 250,
    },
    monetag: {
      enabled: settings.monetag_enabled === 'true' && thirdPartyEnabled,
      nativeEnabled: settings.monetag_native_enabled === 'true',
      sidebarEnabled: settings.monetag_sidebar_enabled === 'true',
      bannerEnabled: settings.monetag_banner_enabled === 'true',
      scriptUrl: APPROVED_MONETAG_SCRIPT_URL,
      allowedDomains: monetagAllowedDomains,
      zones: {
        native: settings.monetag_native_zone_id || APPROVED_MONETAG_ZONE_ID,
        sidebar: settings.monetag_sidebar_zone_id || APPROVED_MONETAG_ZONE_ID,
        banner: settings.monetag_banner_zone_id || APPROVED_MONETAG_ZONE_ID,
      },
      allowedPages: parseJsonList(settings.monetag_allowed_pages, ['home', 'video', 'creator', 'feed', 'search', 'live']).map(String),
      allowedSlots: parseJsonList(settings.monetag_allowed_slots, []).map(String),
    },
    exoClick: {
      enabled: settings.ad_revenue_enabled !== 'false' && thirdPartyEnabled && Boolean(exoClickProvider),
      scriptUrl: exoClickProvider?.scriptUrl || EXOCLICK_DISPLAY_SCRIPT_URL,
      zoneId: exoClickSidebarZone?.zoneId || EXOCLICK_DISPLAY_ZONE_ID,
      config: exoClickProvider?.config || {},
      zoneConfig: exoClickSidebarZone?.config || {},
      width: exoClickSidebarZone?.width || 300,
      height: exoClickSidebarZone?.height || 250,
    },
    slots: active.map((s) => ({
      slotKey: s.slot_key,
      name: s.name,
      page: s.page,
      location: s.location,
      width: s.width,
      height: s.height,
      sizeLabel: s.size_label,
      providerType: s.provider_type,
      providerId: s.provider_id || 'juicyads',
      zoneId: s.zone_id || (String(s.provider_id || '').toLowerCase() === 'monetag'
        ? (defaultMonetagZoneId(settings, slotKind(s)) || APPROVED_MONETAG_ZONE_ID)
        : String(s.provider_id || '').toLowerCase() === 'exoclick'
          ? (exoClickSidebarZone?.zoneId || EXOCLICK_DISPLAY_ZONE_ID)
          : juicyZoneId),
      zoneConfig: String(s.provider_id || '').toLowerCase() === 'exoclick'
        ? { ...(exoClickSidebarZone?.config || {}), ...(s.config || {}) }
        : (s.config || {}),
      placement: slotPlacementKey(s),
      displayMode: s.display_mode,
      customEnabled: s.custom_enabled && customEnabled,
      thirdPartyEnabled: providerThirdPartyEnabled(s, settings, thirdPartyEnabled),
      deviceTarget: s.device_target,
      priority: s.priority,
      embedCode: s.embed_code || null,
    })),
  };

  if (!page) {
    slotCache = payload;
    slotCacheAt = now;
  }
  return payload;
}

export async function resolveSlotRenderPlan(slotKey, { customAd = null } = {}) {
  const slot = await getAdSlotByKey(slotKey);
  if (!slot || !slot.is_active || !isScheduled(slot)) return { type: 'none' };

  const settings = await getPlatformSettingsMap();
  if (settings.sidebar_ads_enabled === 'false') return { type: 'none' };

  const hasCustom = Boolean(customAd) && slot.custom_enabled && settings.sidebar_custom_ads_enabled !== 'false';
  const hasThirdParty = providerThirdPartyEnabled(slot, settings, settings.sidebar_third_party_enabled !== 'false');
  const mode = slot.display_mode || 'custom_first';

  if (mode === 'custom_only') return hasCustom ? { type: 'custom', ad: customAd, slot } : { type: 'none', slot };
  if (mode === 'third_party_only') return hasThirdParty ? { type: 'third_party', slot } : { type: 'none', slot };
  if (mode === 'third_party_first') return hasThirdParty ? { type: 'third_party', slot } : (hasCustom ? { type: 'custom', ad: customAd, slot } : { type: 'none', slot });
  if (mode === 'rotate') {
    const pick = Math.floor(Date.now() / 60000) % 2;
    if (pick === 0 && hasCustom) return { type: 'custom', ad: customAd, slot };
    if (hasThirdParty) return { type: 'third_party', slot };
    return hasCustom ? { type: 'custom', ad: customAd, slot } : { type: 'none', slot };
  }
  return hasCustom ? { type: 'custom', ad: customAd, slot } : (hasThirdParty ? { type: 'third_party', slot } : { type: 'none', slot });
}

export async function incrementSlotStats(slotKey, { impressions = 0, clicks = 0 } = {}) {
  if (!supabase || !slotKey) return;
  const slot = await getAdSlotByKey(slotKey);
  if (!slot) return;
  await supabase.from('ad_slots').update({
    impressions: Number(slot.impressions || 0) + impressions,
    clicks: Number(slot.clicks || 0) + clicks,
    updated_at: new Date().toISOString(),
  }).eq('slot_key', slotKey);
}

function getDefaultSlots() {
  return [
    { slot_key: 'home_sidebar', name: 'Home Sidebar MPU', page: 'home', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 10, impressions: 0, clicks: 0 },
    { slot_key: 'video_sidebar', name: 'Video Page Sidebar', page: 'video', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 20, impressions: 0, clicks: 0 },
    { slot_key: 'video_recommended', name: 'Video Recommended Sidebar', page: 'video', location: 'recommended', width: 300, height: 250, size_label: '300x250', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 30, impressions: 0, clicks: 0 },
    { slot_key: 'creator_sidebar', name: 'Creator Sidebar MPU', page: 'creator', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 40, impressions: 0, clicks: 0 },
    { slot_key: 'live_sidebar', name: 'Live Sidebar MPU', page: 'live', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 50, impressions: 0, clicks: 0 },
  ];
}

export const AD_SIZES = [
  { label: '300x250', width: 300, height: 250 },
];

export const AD_PAGES = [
  'home', 'video', 'creator', 'live', 'random', 'feed', 'search', 'dashboard', 'studio',
];
