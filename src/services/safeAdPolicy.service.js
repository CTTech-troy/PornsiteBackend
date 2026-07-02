export const APPROVED_PLACEMENTS = {
  sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  home_after_subheader_900x250: { maxWidth: 728, maxHeight: 90, formats: ['banner', 'display'] },
  homepage_top: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  homepage_bottom: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  sticky_banner: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  home_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  home_softcore_160x600: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  video_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  video_slider: { maxWidth: 336, maxHeight: 600, formats: ['display', 'video'] },
  video_recommended: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  creator_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  live_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  feed_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  search_sidebar: { maxWidth: 336, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  before_footer: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  feed: { maxWidth: 970, maxHeight: 400, formats: ['banner', 'display', 'native'] },
  feed_native: { maxWidth: 640, maxHeight: 400, formats: ['native', 'display'] },
  mobile_inline: { maxWidth: 640, maxHeight: 400, formats: ['native', 'display', 'banner'] },
  category_feed: { maxWidth: 640, maxHeight: 400, formats: ['native', 'display'] },
  video_page: { maxWidth: 970, maxHeight: 600, formats: ['banner', 'display', 'native'] },
  native_card: { maxWidth: 640, maxHeight: 400, formats: ['native', 'display'] },
  between_content: { maxWidth: 728, maxHeight: 120, formats: ['banner', 'display', 'native'] },
  homepage_banner: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  leaderboard: { maxWidth: 970, maxHeight: 120, formats: ['banner', 'display'] },
  banner: { maxWidth: 970, maxHeight: 280, formats: ['banner', 'display'] },
  video_preroll: { maxWidth: 1920, maxHeight: 1080, formats: ['vast', 'video'] },
  video_midroll: { maxWidth: 1920, maxHeight: 1080, formats: ['vast', 'video'] },
};

export const SAFE_DISPLAY_FORMATS = ['banner', 'display', 'native', 'vast', 'video'];

export const APPROVED_MONETAG_SCRIPT_URL = 'https://quge5.com/88/tag.min.js';
export const APPROVED_MONETAG_ZONE_ID = '242279';
export const APPROVED_JUICYADS_SCRIPT_URL = 'https://poweredby.jads.co/js/jads.js';

export const MONETAG_SAFE_DOMAINS = [
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
  '5gvci.com',
];

export const BLOCKED_SCRIPT_HOSTS_STRICT = [
  'adserver.juicyads.com',
  'popads',
  'popcash',
  'propellerads',
  'onclickads',
];

const AGGRESSIVE_SCRIPT_PATTERN =
  /popunder|clickunder|interstitial|popup|auto.?redirect|direct.?link|social.?bar|in.?page.?push|push.?notification|top\.location|window\.open|window\.top|betway|casino|gambling|adserver\.juicyads\.com|popads|popcash|propellerads|onclickads/i;

const PLACEMENT_ALIASES = {
  home_after_subheader_900x250: 'banner',
  homepage_top: 'banner',
  homepage_bottom: 'banner',
  sticky_banner: 'banner',
  home_sidebar: 'sidebar',
  home_softcore_160x600: 'sidebar',
  before_footer: 'banner',
  video_sidebar: 'sidebar',
  video_slider: 'sidebar',
  creator_sidebar: 'sidebar',
  live_sidebar: 'sidebar',
  feed_sidebar: 'sidebar',
  search_sidebar: 'sidebar',
  video_recommended: 'sidebar',
  recommended_sidebar: 'sidebar',
  feed_native: 'native_card',
  homepage_feed: 'native_card',
  in_feed: 'native_card',
  feed_side_widget: 'native_card',
  category_feed: 'native_card',
  mobile_inline: 'native_card',
};

const ALLOWED_AD_DOMAINS = [
  'juicyads.com',
  'www.juicyads.com',
  'js.juicyads.com',
  'poweredby.jads.co',
  'jads.co',
  'exoclick.com',
  'magsrv.com',
  'a.magsrv.com',
  's.magsrv.com',
  'vast.yomeno.xyz',
  'yomeno.xyz',
  'googleads.g.doubleclick.net',
  'securepubads.g.doubleclick.net',
  'googlesyndication.com',
  'adtng.com',
  'a.adtng.com',
  ...MONETAG_SAFE_DOMAINS,
];

const BLOCKED_HTML_PATTERNS = [
  /position\s*:\s*fixed/i,
  /position\s*:\s*absolute[^;]*;\s*[^;]*z-index\s*:\s*\d{4,}/i,
  /window\.top\s*=/i,
  /window\.parent\s*=/i,
  /<script\b/i,
  /document\.location\s*=/i,
  /top\.location/i,
  /popunder/i,
  /clickunder/i,
  /auto\s*redirect/i,
  /<meta[^>]+http-equiv=["']refresh/i,
  /on(load|click|mouseover)\s*=/i,
  /role\s*=\s*["']dialog["']/i,
  /100vh|100vw/i,
  /betway/i,
  /sportsbet/i,
  /casino/i,
  /interstitial/i,
];

const BLOCKED_JUICY_SNIPPET_PATTERN =
  /top\.location|window\.top|window\.open|document\.location|<meta[^>]+http-equiv=["']refresh|on(load|click|mouseover)\s*=|popunder|clickunder|interstitial|popup|auto.?redirect|direct.?link|social.?bar|adserver\.juicyads\.com|betway|casino|gambling/i;

const BLOCKED_FORMATS = ['popunder', 'clickunder', 'floating', 'fullscreen_takeover', 'interstitial', 'popup', 'modal'];
const MONETAG_ALLOWED_FORMATS = ['banner', 'display', 'native'];
const MONETAG_NATIVE_PLACEMENTS = new Set(['feed', 'feed_native', 'homepage_feed', 'in_feed', 'feed_side_widget', 'category_feed', 'mobile_inline', 'native_card', 'between_content']);
const MONETAG_SIDEBAR_PLACEMENTS = new Set([
  'sidebar',
  'home_sidebar',
  'home_softcore_160x600',
  'video_sidebar',
  'video_recommended',
  'creator_sidebar',
  'live_sidebar',
  'feed_sidebar',
  'search_sidebar',
  'recommended_sidebar',
]);
const MONETAG_BANNER_PLACEMENTS = new Set(['homepage_banner', 'homepage_top', 'homepage_bottom', 'sticky_banner', 'leaderboard', 'banner', 'before_footer', 'home_after_subheader_900x250']);

const CODE_MANAGED_SAFE_AD_SETTINGS = Object.freeze({
  ad_allowed_placements: JSON.stringify(Object.keys(APPROVED_PLACEMENTS)),
  ad_allowed_domains: JSON.stringify(ALLOWED_AD_DOMAINS),
  ad_allowed_formats: JSON.stringify(SAFE_DISPLAY_FORMATS),
  ad_preroll_enabled: 'true',
  ad_feed_ads_enabled: 'true',
  ad_banner_ads_enabled: 'true',
  ad_max_width_px: '970',
  ad_max_height_px: '600',
  sidebar_ads_enabled: 'true',
  juicyads_script_url: APPROVED_JUICYADS_SCRIPT_URL,
  monetag_enabled: 'true',
  monetag_native_enabled: 'true',
  monetag_sidebar_enabled: 'true',
  monetag_banner_enabled: 'true',
  monetag_script_url: APPROVED_MONETAG_SCRIPT_URL,
  monetag_native_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_sidebar_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_banner_zone_id: APPROVED_MONETAG_ZONE_ID,
  monetag_allowed_pages: '["home","video","creator","feed","search","live"]',
  monetag_allowed_slots: '["feed_native","home_after_subheader_900x250","home_sidebar","video_sidebar","video_recommended","creator_sidebar","live_sidebar","feed_sidebar","search_sidebar","before_footer","homepage_banner","leaderboard","banner"]',
  monetag_allowed_domains: JSON.stringify(MONETAG_SAFE_DOMAINS),
});

export async function getSafeAdPolicySettings() {
  const map = CODE_MANAGED_SAFE_AD_SETTINGS;
  const strict = true;
  const safeFormatsOnly = true;
  const allowedPlacements = uniqueList([
    ...parseJsonList(map.ad_allowed_placements, Object.keys(APPROVED_PLACEMENTS)),
    ...Object.keys(APPROVED_PLACEMENTS),
  ])
    .filter((p) => Object.prototype.hasOwnProperty.call(APPROVED_PLACEMENTS, p));
  const monetagAllowedDomains = parseDomainList(map.monetag_allowed_domains, MONETAG_SAFE_DOMAINS);
  const allowedDomains = uniqueList([
    ...parseDomainList(map.ad_allowed_domains, ALLOWED_AD_DOMAINS),
    ...ALLOWED_AD_DOMAINS,
    ...monetagAllowedDomains,
  ]);
  return {
    strictMode: strict,
    allowPreRoll: map.ad_preroll_enabled !== 'false',
    allowSidebarAds: map.sidebar_ads_enabled !== 'false',
    allowFeedAds: map.ad_feed_ads_enabled !== 'false',
    blockPopups: true,
    blockRedirects: true,
    allowPopups: false,
    allowRedirects: false,
    allowFloatingAds: false,
    blockAggressiveBehavior: true,
    blockInterstitials: true,
    blockClickHijacking: true,
    safeFormatsOnly,
    maxGlobalWidth: Math.min(970, Number(map.ad_max_width_px) || 970),
    maxGlobalHeight: Math.min(600, Number(map.ad_max_height_px) || 600),
    allowedPlacements,
    allowedDomains,
    allowedFormats: parseJsonList(map.ad_allowed_formats, SAFE_DISPLAY_FORMATS).filter((f) => SAFE_DISPLAY_FORMATS.includes(f)),
    guardEnabled: true,
    clickIsolation: true,
    prerollEnabled: map.ad_preroll_enabled !== 'false',
    feedAdsEnabled: map.ad_feed_ads_enabled !== 'false',
    sidebarAdsEnabled: map.sidebar_ads_enabled !== 'false',
    bannerAdsEnabled: map.ad_banner_ads_enabled !== 'false',
    juicyScriptUrl: map.juicyads_script_url || 'https://poweredby.jads.co/js/jads.js',
    monetagEnabled: map.monetag_enabled === 'true',
    monetagNativeEnabled: map.monetag_native_enabled === 'true',
    monetagSidebarEnabled: map.monetag_sidebar_enabled === 'true',
    monetagBannerEnabled: map.monetag_banner_enabled === 'true',
    monetagScriptUrl: sanitizeAdUrl(map.monetag_script_url || ''),
    monetagNativeZoneId: String(map.monetag_native_zone_id || ''),
    monetagSidebarZoneId: String(map.monetag_sidebar_zone_id || ''),
    monetagBannerZoneId: String(map.monetag_banner_zone_id || ''),
    monetagAllowedPages: parseJsonList(map.monetag_allowed_pages, ['home', 'video', 'creator', 'feed', 'search', 'live'])
      .map(String)
      .filter(Boolean),
    monetagAllowedSlots: parseJsonList(map.monetag_allowed_slots, [
      'feed_native',
      'home_after_subheader_900x250',
      'home_sidebar',
      'video_sidebar',
      'video_recommended',
      'creator_sidebar',
      'live_sidebar',
      'feed_sidebar',
      'search_sidebar',
      'before_footer',
      'homepage_banner',
      'leaderboard',
      'banner',
    ]).map(String).filter(Boolean),
    monetagAllowedDomains,
  };
}

function parseJsonList(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueList(values) {
  return [...new Set((values || []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean))];
}

function isSafeDomainValue(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!domain || domain.length > 253) return false;
  if (domain.includes('/') || domain.includes(':') || domain.includes('*')) return false;
  if (AGGRESSIVE_SCRIPT_PATTERN.test(domain)) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain);
}

function parseDomainList(raw, fallback) {
  return uniqueList(parseJsonList(raw, fallback)).filter(isSafeDomainValue);
}

function readHtmlAttr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? String(match[1] || match[2] || match[3] || '').trim() : '';
}

function normalizeJuicyScriptUrl(src) {
  const value = String(src || '').trim().replace(/^\/\//, 'https://');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname.toLowerCase() !== 'poweredby.jads.co') return '';
    if (parsed.pathname !== '/js/jads.js') return '';
    return APPROVED_JUICYADS_SCRIPT_URL;
  } catch {
    return '';
  }
}

function isJuicyPushBody(body, zoneId) {
  const re = new RegExp(
    `^\\(?\\s*adsbyjuicy\\s*=\\s*window\\.adsbyjuicy\\s*\\|\\|\\s*\\[\\]\\s*\\)?\\s*\\.push\\s*\\(\\s*\\{\\s*['"]?adzone['"]?\\s*:\\s*['"]?${zoneId}['"]?\\s*\\}\\s*\\)\\s*;?\\s*$`,
    'i',
  );
  return re.test(String(body || '').trim());
}

export function parseTrustedJuicyEmbedHtml(html) {
  const raw = String(html || '').trim().replace(/\b(src|href)=(["'])\/\//gi, '$1=$2https://');
  if (!raw || BLOCKED_JUICY_SNIPPET_PATTERN.test(raw)) return null;

  const insMatch = raw.match(/<ins\b[^>]*>/i);
  if (!insMatch) return null;

  const insTag = insMatch[0];
  const zoneFromIns = readHtmlAttr(insTag, 'id');
  const pushMatch = raw.match(/\.push\s*\(\s*\{\s*['"]?adzone['"]?\s*:\s*['"]?(\d+)['"]?\s*\}\s*\)/i);
  const zoneId = String(pushMatch?.[1] || zoneFromIns || '').trim();

  if (!/^\d+$/.test(zoneId)) return null;
  if (zoneFromIns && zoneFromIns !== zoneId) return null;

  const scriptTags = [...raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if (scriptTags.length > 2) return null;

  let hasJuicyPush = false;
  for (const scriptTag of scriptTags) {
    const attrs = scriptTag[1] || '';
    const body = scriptTag[2] || '';
    const src = readHtmlAttr(attrs, 'src');

    if (src) {
      if (!normalizeJuicyScriptUrl(src) || body.trim()) return null;
      continue;
    }

    if (!isJuicyPushBody(body, zoneId)) return null;
    hasJuicyPush = true;
  }

  if (scriptTags.length && !hasJuicyPush) return null;
  if (!scriptTags.length && !pushMatch) return null;

  return {
    provider: 'juicyads',
    zoneId,
    width: Number(readHtmlAttr(insTag, 'data-width')) || 300,
    height: Number(readHtmlAttr(insTag, 'data-height')) || 250,
    scriptUrl: APPROVED_JUICYADS_SCRIPT_URL,
  };
}

export function isApprovedMonetagScriptUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const approved = new URL(APPROVED_MONETAG_SCRIPT_URL);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === approved.hostname
      && parsed.pathname === approved.pathname;
  } catch {
    return false;
  }
}

export function sanitizeAdUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (isApprovedMonetagScriptUrl(value)) return APPROVED_MONETAG_SCRIPT_URL;
  if (AGGRESSIVE_SCRIPT_PATTERN.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isAggressiveScriptUrl(url, settings = {}) {
  const s = String(url || '').toLowerCase();
  if (!s) return false;
  if (isApprovedMonetagScriptUrl(s)) return false;
  if (s.includes('quge5.com')) return true;
  if (AGGRESSIVE_SCRIPT_PATTERN.test(s)) return true;
  if (settings.strictMode !== false || settings.blockInterstitials !== false) {
    return BLOCKED_SCRIPT_HOSTS_STRICT.some((host) => s.includes(host));
  }
  return false;
}

export function resolvePlacementSpec(placement) {
  const key = PLACEMENT_ALIASES[placement] || placement;
  return APPROVED_PLACEMENTS[placement] || APPROVED_PLACEMENTS[key] || null;
}

export function isPlacementAllowed(placement, settings) {
  const spec = resolvePlacementSpec(placement);
  if (!spec) return { ok: false, reason: 'placement_not_approved' };
  if (!settings.allowedPlacements.includes(placement) && !settings.allowedPlacements.includes(PLACEMENT_ALIASES[placement] || '')) {
    return { ok: false, reason: 'placement_disabled_by_admin' };
  }
  return { ok: true, spec };
}

export function validateDimensions(placement, width, height, settings) {
  const placementCheck = isPlacementAllowed(placement, settings);
  if (!placementCheck.ok) return placementCheck;

  const { spec } = placementCheck;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return { ok: false, reason: 'invalid_dimensions' };
  if (w > settings.maxGlobalWidth || h > settings.maxGlobalHeight) {
    return { ok: false, reason: 'exceeds_global_max' };
  }
  if (w > spec.maxWidth || h > spec.maxHeight) {
    return { ok: false, reason: 'exceeds_placement_max' };
  }
  return { ok: true, spec, width: w, height: h };
}

export function isDomainAllowed(url, settings) {
  if (!url) return true;
  if (isAggressiveScriptUrl(url, settings)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return settings.allowedDomains.some((d) => {
      if (d === 'juicyads.com') return host === d;
      return host === d || host.endsWith(`.${d}`);
    });
  } catch {
    return false;
  }
}

export function validateEmbedHtml(html, settings = {}) {
  const s = String(html || '');
  if (!s.trim()) return { ok: false, reason: 'empty_embed' };
  const trustedJuicyEmbed = parseTrustedJuicyEmbedHtml(s);
  if (trustedJuicyEmbed) return { ok: true, ...trustedJuicyEmbed };
  for (const pattern of BLOCKED_HTML_PATTERNS) {
    if (pattern.test(s)) return { ok: false, reason: 'unsafe_embed_pattern' };
  }
  if (settings.blockAggressiveBehavior !== false) {
    if (/<iframe[^>]+style=["'][^"']*(fixed|100vh|100vw)/i.test(s)) {
      return { ok: false, reason: 'iframe_viewport_takeover' };
    }
  }
  return { ok: true };
}

export function validateProviderFormat(providerSlug, format, settings) {
  const fmt = String(format || 'display').toLowerCase();
  if (BLOCKED_FORMATS.includes(fmt)) {
    return { ok: false, reason: 'format_blocked' };
  }
  if (settings.safeFormatsOnly && !settings.allowedFormats.includes(fmt)) {
    return { ok: false, reason: 'format_not_allowed' };
  }
  const slug = String(providerSlug || '').toLowerCase();
  if (slug === 'monetag') {
    if (!MONETAG_ALLOWED_FORMATS.includes(fmt)) {
      return { ok: false, reason: 'provider_format_not_allowed' };
    }
    return { ok: true };
  }
  if (slug === 'exoclick' && !['banner', 'display', 'native', 'vast', 'video'].includes(fmt)) {
    return { ok: false, reason: 'provider_format_not_allowed' };
  }
  if (slug === 'juicyads' && !['banner', 'display', 'native'].includes(fmt)) {
    return { ok: false, reason: 'provider_format_not_allowed' };
  }
  return { ok: true };
}

export function validateMonetagPlacement(placement, format = 'display') {
  const fmt = String(format || 'display').toLowerCase();
  if (!MONETAG_ALLOWED_FORMATS.includes(fmt)) {
    return { ok: false, reason: 'monetag_format_not_allowed' };
  }
  const key = PLACEMENT_ALIASES[placement] || placement;
  if (MONETAG_NATIVE_PLACEMENTS.has(placement) || MONETAG_NATIVE_PLACEMENTS.has(key)) return { ok: true, kind: 'native' };
  if (MONETAG_SIDEBAR_PLACEMENTS.has(placement) || MONETAG_SIDEBAR_PLACEMENTS.has(key)) return { ok: true, kind: 'sidebar' };
  if (MONETAG_BANNER_PLACEMENTS.has(placement) || MONETAG_BANNER_PLACEMENTS.has(key)) return { ok: true, kind: 'banner' };
  return { ok: false, reason: 'monetag_placement_not_allowed' };
}

export async function validateAdForRender({
  placement,
  width,
  height,
  providerSlug,
  format,
  embedHtml,
  scriptUrl,
  tagUrl,
} = {}) {
  const settings = await getSafeAdPolicySettings();
  const placementResult = validateDimensions(placement, width, height, settings);
  if (!placementResult.ok) return placementResult;
  const fmt = String(format || 'display').toLowerCase();
  if (placementResult.spec?.formats?.length && !placementResult.spec.formats.includes(fmt)) {
    return { ok: false, reason: 'format_not_allowed_for_placement' };
  }

  const formatResult = validateProviderFormat(providerSlug, format, settings);
  if (!formatResult.ok) return formatResult;

  if (String(providerSlug || '').toLowerCase() === 'monetag') {
    const monetagResult = validateMonetagPlacement(placement, format);
    if (!monetagResult.ok) return monetagResult;
  }

  if (embedHtml) {
    const embedResult = validateEmbedHtml(embedHtml, settings);
    if (!embedResult.ok) return embedResult;
  }

  const url = scriptUrl || tagUrl;
  if (isAggressiveScriptUrl(url, settings)) {
    return { ok: false, reason: 'aggressive_script_blocked' };
  }
  if (url && !isDomainAllowed(url, settings)) {
    return { ok: false, reason: 'domain_not_whitelisted' };
  }

  return { ok: true, settings, ...placementResult };
}

export async function getPublicSafeAdPolicy() {
  const settings = await getSafeAdPolicySettings();
  return {
    ...settings,
    approvedPlacements: Object.keys(APPROVED_PLACEMENTS),
    placementSpecs: APPROVED_PLACEMENTS,
    blockedFormats: BLOCKED_FORMATS,
    safeDisplayFormats: SAFE_DISPLAY_FORMATS,
    blockedScriptHosts: BLOCKED_SCRIPT_HOSTS_STRICT,
  };
}
