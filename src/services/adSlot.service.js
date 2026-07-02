import { supabase } from '../config/supabase.js';
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

const CODE_MANAGED_SLOT_SETTINGS = Object.freeze({
  sidebar_ads_enabled: 'true',
  sidebar_custom_ads_enabled: 'true',
  sidebar_third_party_enabled: 'true',
  ad_revenue_enabled: 'true',
  google_ad_manager_enabled: 'false',
  juicyads_enabled: 'true',
  juicyads_sidebar_zone_id: '1118510',
  juicyads_script_url: 'https://poweredby.jads.co/js/jads.js',
  monetag_enabled: 'true',
  monetag_native_enabled: 'true',
  monetag_sidebar_enabled: 'true',
  monetag_banner_enabled: 'true',
  monetag_native_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_sidebar_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_banner_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_allowed_pages: '["home","video","creator","feed","search","live"]',
  monetag_allowed_slots: '["home_feed_native","home_mobile_inline_300x100","category_feed_native","feed_native","mobile_inline","category_feed","home_after_subheader_900x250","home_sidebar","home_bottom_900x250","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","before_footer","homepage_banner","homepage_top","homepage_bottom","leaderboard","banner"]',
  monetag_allowed_domains: '["quge5.com","monetag.com","www.monetag.com","highperformanceformat.com","effectivecpmnetwork.com","pl30142051.effectivecpmnetwork.com","profitablecpmrate.com","profitablecpmgate.com","alwingulla.com","kettledroopingcontinuation.com","sleepoverlimitprofound.com","fizzyacerbitymellow.com","cloudvideosa.com","protrafficinspector.com","5gvci.com"]',
});

function codeManagedAdsError() {
  const err = new Error('Ad slots are managed manually in the codebase.');
  err.status = 410;
  err.code = 'ADS_MANAGED_IN_CODE';
  return err;
}

const PAGE_ALIASES = {
  home: ['home', 'homepage', 'main'],
  video: ['video', 'video_detail', 'watch'],
  leaderboard: ['leaderboard'],
  channels: ['channels', 'channel'],
  stars: ['stars', 'pstar', 'pornstars'],
  creator: ['creator'],
  creator_apply: ['creator_apply', 'creator_form'],
  creator_status: ['creator_status'],
  forum: ['forum'],
  webmasters: ['webmasters', 'partners_public'],
  live_streams: ['live_streams'],
  live: ['live', 'live_watch'],
  messages: ['messages'],
  premium: ['premium'],
  legal: ['legal'],
  auth: ['auth', 'login', 'signup'],
  wallet: ['wallet'],
  purchases: ['purchases'],
  application_update: ['application_update', 'apply_update'],
  content_removal: ['content_removal'],
  tiktok: ['tiktok', 'tiktok_video'],
  terms: ['terms'],
  privacy_policy: ['privacy_policy'],
  privacy_notice: ['privacy_notice'],
  cookies: ['cookies'],
  feed: ['feed'],
  category: ['category', 'category_feed', 'categories'],
  search: ['search'],
  random: ['random', 'random_1v1'],
  dashboard: ['dashboard', 'user_dashboard'],
  studio: ['studio', 'creator_studio'],
};

export const AD_PAGE_DEFINITIONS = [
  { key: 'home', label: 'Home', path: '/' },
  { key: 'video', label: 'Video watch', path: '/video/:videoId' },
  { key: 'leaderboard', label: 'Leaderboard', path: '/leaderboard' },
  { key: 'channels', label: 'Channels', path: '/channels' },
  { key: 'stars', label: 'Stars', path: '/stars' },
  { key: 'creator', label: 'Creator profile', path: '/creator/:slug' },
  { key: 'creator_apply', label: 'Creator application', path: '/creator/form' },
  { key: 'creator_status', label: 'Creator status', path: '/creator/status' },
  { key: 'forum', label: 'Forum', path: '/forum' },
  { key: 'webmasters', label: 'Webmasters', path: '/webmasters' },
  { key: 'live_streams', label: 'Live streams', path: '/live-streams' },
  { key: 'live', label: 'Live cams/watch', path: '/live' },
  { key: 'messages', label: 'Messages', path: '/messages' },
  { key: 'premium', label: 'Premium', path: '/premium' },
  { key: 'legal', label: 'Legal info', path: '/legal/:section' },
  { key: 'auth', label: 'Auth pages', path: '/login /signup /auth/*' },
  { key: 'wallet', label: 'Wallet', path: '/wallet' },
  { key: 'purchases', label: 'Purchases', path: '/purchases' },
  { key: 'application_update', label: 'Application update', path: '/apply/update' },
  { key: 'content_removal', label: 'Content removal', path: '/content-removal' },
  { key: 'tiktok', label: 'TikTok feed/watch', path: '/tiktok' },
  { key: 'category', label: 'Category feed', path: '/category/:slug' },
  { key: 'terms', label: 'Terms', path: '/terms' },
  { key: 'privacy_policy', label: 'Privacy policy', path: '/privacy-policy' },
  { key: 'privacy_notice', label: 'Privacy notice', path: '/privacy-notice' },
  { key: 'cookies', label: 'Cookie preferences', path: '/cookies' },
];

const FOOTER_BANNER_WIDTH = 900;
const FOOTER_BANNER_HEIGHT = 250;
const HOME_AFTER_SUBHEADER_SLOT_KEY = 'home_after_subheader_900x250';
const HOME_AFTER_SUBHEADER_BANNER_NAME = 'Home After Subheader Banner 728x90';
const HOME_AFTER_SUBHEADER_BANNER_WIDTH = 728;
const HOME_AFTER_SUBHEADER_BANNER_HEIGHT = 90;
const HOME_AFTER_SUBHEADER_BANNER_SIZE = '728x90';
const HOME_AFTER_SUBHEADER_ADSTERRA_KEY = '8af10b683371ed20d23f25c00177c8e8';
const HOME_AFTER_SUBHEADER_ADSTERRA_EMBED_CODE = `<script>
  atOptions = {
    'key' : '${HOME_AFTER_SUBHEADER_ADSTERRA_KEY}',
    'format' : 'iframe',
    'height' : 90,
    'width' : 728,
    'params' : {}
  };
</script>
<script src="https://www.highperformanceformat.com/${HOME_AFTER_SUBHEADER_ADSTERRA_KEY}/invoke.js"></script>`;
const SLOT_LOCATIONS = new Set([
  'sidebar',
  'recommended',
  'before_footer',
  'after_subheader',
  'feed_native',
  'homepage_top',
  'homepage_bottom',
  'mobile_inline',
  'category_feed',
  'video_page',
  'sticky_banner',
]);

export function beforeFooterSlotKey(pageKey) {
  const page = String(pageKey || 'home').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'home';
  return `${page}_before_footer_900x250`;
}

function pageLabel(pageKey) {
  return AD_PAGE_DEFINITIONS.find((page) => page.key === pageKey)?.label || String(pageKey || 'Page');
}

function normalizeSlotLocation(value) {
  const location = String(value || 'sidebar').trim().toLowerCase();
  return SLOT_LOCATIONS.has(location) ? location : 'sidebar';
}

function isHomeAfterSubheaderSlot(slot = {}, location = null) {
  const resolvedLocation = String(location || slot.location || '').toLowerCase();
  return (
    slot.slot_key === HOME_AFTER_SUBHEADER_SLOT_KEY ||
    slot.slotKey === HOME_AFTER_SUBHEADER_SLOT_KEY ||
    (String(slot.page || '').toLowerCase() === 'home' && resolvedLocation === 'after_subheader')
  );
}

function normalizeHomeAfterSubheaderSlot(slot = {}) {
  if (!isHomeAfterSubheaderSlot(slot)) return slot;
  return {
    ...slot,
    slot_key: HOME_AFTER_SUBHEADER_SLOT_KEY,
    name: HOME_AFTER_SUBHEADER_BANNER_NAME,
    page: 'home',
    location: 'after_subheader',
    width: HOME_AFTER_SUBHEADER_BANNER_WIDTH,
    height: HOME_AFTER_SUBHEADER_BANNER_HEIGHT,
    size_label: HOME_AFTER_SUBHEADER_BANNER_SIZE,
    provider_type: 'custom',
    provider_id: 'highperformanceformat',
    zone_id: HOME_AFTER_SUBHEADER_ADSTERRA_KEY,
    embed_code: HOME_AFTER_SUBHEADER_ADSTERRA_EMBED_CODE,
    display_mode: 'custom_only',
    custom_enabled: true,
    third_party_enabled: false,
    device_target: slot.device_target || 'all',
  };
}

function slotDimensionLimits(location) {
  if (['before_footer', 'after_subheader', 'homepage_top', 'homepage_bottom', 'sticky_banner'].includes(location)) {
    return { width: 970, height: 280 };
  }
  if (['feed_native', 'category_feed', 'mobile_inline'].includes(location)) return { width: 640, height: 400 };
  if (location === 'video_page') return { width: 970, height: 600 };
  return { width: 336, height: 600 };
}

function normalizeSlotDimensions(slot, location) {
  if (isHomeAfterSubheaderSlot(slot, location)) {
    return {
      width: HOME_AFTER_SUBHEADER_BANNER_WIDTH,
      height: HOME_AFTER_SUBHEADER_BANNER_HEIGHT,
    };
  }
  const limits = slotDimensionLimits(location);
  return {
    width: Math.min(Number(slot.width) || 300, limits.width),
    height: Math.min(Number(slot.height) || 250, limits.height),
  };
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

function parseSlotConfig(slot) {
  const raw = slot?.config || {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function slotPlacementKey(slot) {
  const config = parseSlotConfig(slot);
  if (config.placement_type || config.placementType || config.placement) {
    return String(config.placement_type || config.placementType || config.placement).trim().toLowerCase();
  }
  if (slot.location === 'feed_native') return 'feed_native';
  if (slot.location === 'homepage_top') return 'homepage_top';
  if (slot.location === 'homepage_bottom') return 'homepage_bottom';
  if (slot.location === 'mobile_inline') return 'mobile_inline';
  if (slot.location === 'category_feed') return 'category_feed';
  if (slot.location === 'video_page') return 'video_page';
  if (slot.location === 'sticky_banner') return 'sticky_banner';
  if (slot.location === 'after_subheader' || slot.slot_key === HOME_AFTER_SUBHEADER_SLOT_KEY) return HOME_AFTER_SUBHEADER_SLOT_KEY;
  if (slot.location === 'before_footer') return 'before_footer';
  if (slot.page === 'home') return 'home_sidebar';
  if (slot.page === 'video' && slot.location === 'recommended') return 'video_recommended';
  if (slot.page === 'video') return 'video_sidebar';
  if (slot.page === 'creator') return 'creator_sidebar';
  if (slot.page === 'live') return 'live_sidebar';
  if (slot.page === 'feed') return 'feed_sidebar';
  if (slot.page === 'search') return 'search_sidebar';
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
  if (['feed', 'feed_native', 'category_feed', 'mobile_inline', 'native_card', 'between_content'].includes(placement)) return 'native';
  if (['homepage_banner', 'homepage_top', 'homepage_bottom', 'sticky_banner', 'leaderboard', 'banner', 'before_footer', HOME_AFTER_SUBHEADER_SLOT_KEY].includes(placement)) return 'banner';
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

function isSafeAdSlot(slot) {
  const location = normalizeSlotLocation(slot.location);
  const width = Number(slot.width) || 300;
  const height = Number(slot.height) || 250;
  if (isHomeAfterSubheaderSlot(slot, location)) {
    return width <= HOME_AFTER_SUBHEADER_BANNER_WIDTH && height <= HOME_AFTER_SUBHEADER_BANNER_HEIGHT;
  }
  if (['before_footer', 'after_subheader', 'homepage_top', 'homepage_bottom', 'sticky_banner'].includes(location)) {
    return width <= 970 && height <= 280;
  }
  if (['feed_native', 'category_feed', 'mobile_inline'].includes(location)) return width <= 640 && height <= 400;
  if (location === 'video_page') return width <= 970 && height <= 600;
  return ['sidebar', 'recommended'].includes(location) && width <= 336 && height <= 600;
}

export async function listAdSlots() {
  return getDefaultSlots();
}

export async function getAdSlotByKey(slotKey) {
  const slots = await listAdSlots();
  return slots.find((s) => s.slot_key === slotKey) || null;
}

export async function upsertAdSlot(slot, admin = null) {
  throw codeManagedAdsError();
}

export async function patchAdSlot(slotKey, patch, admin = null) {
  throw codeManagedAdsError();
}

export async function deleteAdSlot(slotKey, admin = null) {
  throw codeManagedAdsError();
}

export function invalidateSlotCache() {
  slotCache = null;
  slotCacheAt = 0;
}

export async function getPublicSlotsConfig({ page = null, device = 'desktop' } = {}) {
  const now = Date.now();
  if (!page && slotCache && now - slotCacheAt < SLOT_CACHE_MS) return slotCache;

  const [slots, providerConfig] = await Promise.all([
    listAdSlots(),
    getPublicAdConfig(),
  ]);
  const settings = CODE_MANAGED_SLOT_SETTINGS;

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
    'effectivecpmnetwork.com',
    'pl30142051.effectivecpmnetwork.com',
    'profitablecpmrate.com',
    'profitablecpmgate.com',
    'alwingulla.com',
    'kettledroopingcontinuation.com',
    'sleepoverlimitprofound.com',
    'fizzyacerbitymellow.com',
    'cloudvideosa.com',
    'protrafficinspector.com',
  ]).map(String);

  const filterSlots = (inputSlots) => inputSlots
    .filter((s) => s.is_active && isScheduled(s))
    .filter(isSafeAdSlot)
    .filter((s) => {
      if (s.device_target === 'all') return true;
      if (s.device_target === 'desktop') return device === 'desktop';
      if (s.device_target === 'tablet') return device === 'tablet' || device === 'desktop';
      if (s.device_target === 'mobile') return device === 'mobile';
      return true;
    });

  let active = filterSlots(slots);

  if (page) {
    const aliases = PAGE_ALIASES[page] || [page];
    active = active.filter((s) => aliases.includes(s.page) || s.page === page);
  }

  if (!active.length) {
    active = filterSlots(getDefaultSlots());
    if (page) {
      const aliases = PAGE_ALIASES[page] || [page];
      active = active.filter((s) => aliases.includes(s.page) || s.page === page);
    }
  }

  const payload = {
    enabled: globalEnabled,
    device,
    layouts: {
      desktop: { columns: 1, maxWidth: 336, gap: 16 },
      tablet: { columns: 1, maxWidth: 336, gap: 14 },
      mobile: { columns: 1, maxWidth: 320, gap: 12, sticky: false },
    },
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
      config: parseSlotConfig(s),
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
        ? { ...(exoClickSidebarZone?.config || {}), ...parseSlotConfig(s) }
        : parseSlotConfig(s),
      placement: slotPlacementKey(s),
      placementType: slotPlacementKey(s),
      displayMode: s.display_mode,
      customEnabled: s.custom_enabled && customEnabled,
      thirdPartyEnabled: providerThirdPartyEnabled(s, settings, thirdPartyEnabled),
      deviceTarget: s.device_target,
      priority: s.priority,
      frequencyCap: Number(s.frequency_cap || 0),
      embedCode: s.embed_code || null,
    })),
    slotMappings: Object.fromEntries(active.map((s) => [s.slot_key, slotPlacementKey(s)])),
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

  const settings = CODE_MANAGED_SLOT_SETTINGS;
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
    { slot_key: HOME_AFTER_SUBHEADER_SLOT_KEY, name: HOME_AFTER_SUBHEADER_BANNER_NAME, page: 'home', location: 'after_subheader', width: HOME_AFTER_SUBHEADER_BANNER_WIDTH, height: HOME_AFTER_SUBHEADER_BANNER_HEIGHT, size_label: HOME_AFTER_SUBHEADER_BANNER_SIZE, provider_type: 'custom', provider_id: 'highperformanceformat', zone_id: HOME_AFTER_SUBHEADER_ADSTERRA_KEY, embed_code: HOME_AFTER_SUBHEADER_ADSTERRA_EMBED_CODE, is_active: true, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_only', device_target: 'all', priority: 8, impressions: 0, clicks: 0, config: { placement_type: HOME_AFTER_SUBHEADER_SLOT_KEY } },
    { slot_key: 'home_feed_native', name: 'Home Feed Native Card', page: 'home', location: 'feed_native', width: 300, height: 250, size_label: '300x250', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: true, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_first', device_target: 'all', priority: 9, frequency_cap: 6, impressions: 0, clicks: 0, config: { placement_type: 'feed_native', insertion_frequency: 6, start_after: 6, max_per_page: 4, card_size: '300x250' } },
    { slot_key: 'home_sidebar', name: 'Home Sidebar MPU', page: 'home', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 10, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'home_right_leaderboard_728x90', name: 'Home Right Rail Leaderboard 728x90', page: 'home', location: 'sidebar', width: 728, height: 90, size_label: '728x90', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: false, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_only', device_target: 'desktop', priority: 11, impressions: 0, clicks: 0, config: { placement_type: 'homepage_banner' } },
    { slot_key: 'home_mobile_inline_300x100', name: 'Home Mobile Inline Banner 300x100', page: 'home', location: 'mobile_inline', width: 300, height: 100, size_label: '300x100', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: false, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_first', device_target: 'mobile', priority: 11, frequency_cap: 8, impressions: 0, clicks: 0, config: { placement_type: 'mobile_inline', insertion_frequency: 8, start_after: 4, max_per_page: 3, card_size: '300x100' } },
    { slot_key: 'home_softcore_160x600', name: 'Home Softcore Banner 160x600', page: 'home', location: 'sidebar', width: 160, height: 600, size_label: '160x600', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: true, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_only', device_target: 'desktop', priority: 12, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'home_bottom_900x250', name: 'Home Bottom Banner 900x250', page: 'home', location: 'homepage_bottom', width: 900, height: 250, size_label: '900x250', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: false, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_only', device_target: 'all', priority: 13, impressions: 0, clicks: 0, config: { placement_type: 'homepage_bottom' } },
    { slot_key: 'video_sidebar', name: 'Video Page Sidebar', page: 'video', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 20, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'video_recommended', name: 'Video Recommended Sidebar', page: 'video', location: 'recommended', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 30, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'creator_sidebar', name: 'Creator Sidebar MPU', page: 'creator', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 40, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'live_sidebar', name: 'Live Sidebar MPU', page: 'live', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 50, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'feed_sidebar', name: 'Feed Sidebar MPU', page: 'feed', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 60, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'search_sidebar', name: 'Search Sidebar MPU', page: 'search', location: 'sidebar', width: 300, height: 250, size_label: '300x250', provider_type: 'mixed', provider_id: 'monetag', zone_id: APPROVED_MONETAG_ZONE_ID, is_active: true, custom_enabled: true, third_party_enabled: true, display_mode: 'third_party_first', device_target: 'all', priority: 70, impressions: 0, clicks: 0, config: {} },
    { slot_key: 'category_feed_native', name: 'Category Feed Native Card', page: 'category', location: 'category_feed', width: 300, height: 250, size_label: '300x250', provider_type: 'custom', provider_id: 'juicyads', zone_id: null, embed_code: null, is_active: false, custom_enabled: true, third_party_enabled: false, display_mode: 'custom_first', device_target: 'all', priority: 80, frequency_cap: 8, impressions: 0, clicks: 0, config: { placement_type: 'category_feed', insertion_frequency: 8, start_after: 6, max_per_page: 3, card_size: '300x250' } },
    ...AD_PAGE_DEFINITIONS.map((page, index) => ({
      slot_key: beforeFooterSlotKey(page.key),
      name: `${page.label} Before Footer Banner 900x250`,
      page: page.key,
      location: 'before_footer',
      width: FOOTER_BANNER_WIDTH,
      height: FOOTER_BANNER_HEIGHT,
      size_label: '900x250',
      provider_type: 'custom',
      provider_id: 'juicyads',
      zone_id: null,
      embed_code: null,
      is_active: true,
      custom_enabled: true,
      third_party_enabled: false,
      display_mode: 'custom_only',
      device_target: 'all',
      priority: 200 + index,
      impressions: 0,
      clicks: 0,
      config: {},
    })),
  ];
}

export function getDefaultAdSlots() {
  return getDefaultSlots().map((slot) => ({ ...slot }));
}

function mergeDefaultSlots(rows = []) {
  const byKey = new Map();
  for (const slot of getDefaultSlots()) byKey.set(slot.slot_key, slot);
  for (const slot of rows || []) {
    if (!slot?.slot_key) continue;
    const existing = byKey.get(slot.slot_key) || {};
    const location = normalizeSlotLocation(slot.location || existing.location);
    const dimensions = normalizeSlotDimensions({ ...existing, ...slot }, location);
    const merged = {
      ...existing,
      ...slot,
      location,
      width: dimensions.width,
      height: dimensions.height,
      size_label: slot.size_label || `${dimensions.width}x${dimensions.height}`,
      provider_type: slot.provider_type || existing.provider_type || 'mixed',
      provider_id: slot.provider_id || existing.provider_id || 'monetag',
      zone_id: slot.zone_id ?? existing.zone_id ?? (slot.provider_type === 'custom' || existing.provider_type === 'custom' ? null : APPROVED_MONETAG_ZONE_ID),
      custom_enabled: slot.custom_enabled !== false,
      third_party_enabled: slot.third_party_enabled !== false,
      display_mode: slot.display_mode || existing.display_mode || 'third_party_first',
      device_target: slot.device_target || existing.device_target || 'all',
      config: parseSlotConfig(slot),
    };
    byKey.set(slot.slot_key, normalizeHomeAfterSubheaderSlot(merged));
  }
  return [...byKey.values()].sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));
}

export const AD_SIZES = [
  { label: '160x600', width: 160, height: 600 },
  { label: '300x100', width: 300, height: 100 },
  { label: '300x250', width: 300, height: 250 },
  { label: '305x99', width: 305, height: 99 },
  { label: '315x300', width: 315, height: 300 },
  { label: '728x90', width: 728, height: 90 },
  { label: '900x250', width: 900, height: 250 },
];

export const AD_PAGES = AD_PAGE_DEFINITIONS.map((page) => page.key);
