import { resolveSlotRenderPlan, incrementSlotStats, getAdSlotByKey } from '../services/adSlot.service.js';
import {
  getCampaignForPlacement,
  getSidebarPoolMeta,
  mapCampaignRow,
} from '../services/adCampaign.service.js';
import { supabase } from '../config/supabase.js';
import { validateAdForRender } from '../services/safeAdPolicy.service.js';
import { getPlatformSettingsMap, resolveVastSettingsFromMap } from '../services/platformSettings.service.js';

const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idz=5963164';
const VAST_PROXY_TIMEOUT_MS = 5000;
const VAST_PROXY_MAX_BYTES = 1_000_000;
const TRUSTED_VAST_HOSTS = ['s.magsrv.com', 'magsrv.com', 'vast.yomeno.xyz', 'yomeno.xyz'];

function normalizeUrlForCompare(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function isTrustedVastHost(parsed) {
  const host = parsed.hostname.toLowerCase();
  return TRUSTED_VAST_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function resolvePublicVastUrl() {
  try {
    const map = await getPlatformSettingsMap();
    const settings = resolveVastSettingsFromMap(map);
    return settings.url || EXOCLICK_VAST_TAG_URL;
  } catch {
    return EXOCLICK_VAST_TAG_URL;
  }
}

async function isTrustedVastUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'https:') return false;
    if (isTrustedVastHost(parsed)) return true;
    const activeUrl = await resolvePublicVastUrl();
    return Boolean(activeUrl) && normalizeUrlForCompare(activeUrl) === normalizeUrlForCompare(parsed.toString());
  } catch {
    return false;
  }
}

function analyzeVastXml(xml) {
  const body = String(xml || '');
  const hasVast = /<VAST(?=[\s>/])/i.test(body);
  const adMatches = body.match(/<Ad(?=[\s>])/gi) || [];
  const wrapperMatches = body.match(/<Wrapper\b/gi) || [];
  const inlineMatches = body.match(/<InLine\b/gi) || [];
  const linearMatches = body.match(/<Linear\b/gi) || [];
  const nonLinearMatches = body.match(/<NonLinear\b/gi) || [];
  const companionMatches = body.match(/<Companion\b/gi) || [];
  const vastAdTagUriMatches = body.match(/<VASTAdTagURI\b/gi) || [];
  const mediaFileMatches = body.match(/<MediaFile\b/gi) || [];
  const staticResourceMatches = body.match(/<StaticResource\b/gi) || [];
  const iframeResourceMatches = body.match(/<IFrameResource\b/gi) || [];
  const htmlResourceMatches = body.match(/<HTMLResource\b/gi) || [];
  const impressionMatches = body.match(/<Impression\b/gi) || [];
  const clickThroughMatches = body.match(/<ClickThrough\b/gi) || [];
  const duration = body.match(/<Duration>\s*([^<]+)\s*<\/Duration>/i)?.[1]?.trim() || '';
  const skipOffset = body.match(/<Linear\b[^>]*\bskipoffset=["']([^"']+)["']/i)?.[1]?.trim() || '';
  const hasPlayableWrapper = wrapperMatches.length > 0 && vastAdTagUriMatches.length > 0;
  const bannerResourceCount = staticResourceMatches.length + iframeResourceMatches.length + htmlResourceMatches.length;
  const hasBannerCreative = (nonLinearMatches.length > 0 || companionMatches.length > 0) && bannerResourceCount > 0;
  const missing = [
    !hasVast ? 'VAST root' : '',
    !adMatches.length ? 'Ad' : '',
    !mediaFileMatches.length && !hasPlayableWrapper && !hasBannerCreative ? 'MediaFile, banner creative, or Wrapper VASTAdTagURI' : '',
    !impressionMatches.length ? 'Impression' : '',
    !duration ? 'Duration' : '',
    !clickThroughMatches.length ? 'ClickThrough' : '',
  ].filter(Boolean);
  const summary = {
    hasVast,
    hasAd: adMatches.length > 0,
    adCount: adMatches.length,
    hasWrapper: wrapperMatches.length > 0,
    wrapperCount: wrapperMatches.length,
    inlineCount: inlineMatches.length,
    linearCount: linearMatches.length,
    nonLinearCount: nonLinearMatches.length,
    companionCount: companionMatches.length,
    vastAdTagUriCount: vastAdTagUriMatches.length,
    hasPlayableWrapper,
    hasBannerCreative,
    bannerResourceCount,
    mediaFileCount: mediaFileMatches.length,
    staticResourceCount: staticResourceMatches.length,
    iframeResourceCount: iframeResourceMatches.length,
    htmlResourceCount: htmlResourceMatches.length,
    impressionCount: impressionMatches.length,
    clickThroughCount: clickThroughMatches.length,
    duration,
    skipOffset,
    missing,
  };
  if (!body.trim()) return { ok: false, reason: 'empty_response', ...summary };
  if (!hasVast) return { ok: false, reason: 'malformed_vast', ...summary };
  if (!adMatches.length) return { ok: false, reason: 'no_fill', legacyReason: 'empty_vast', noFill: true, ...summary };
  if (!mediaFileMatches.length && !hasPlayableWrapper && !hasBannerCreative) return { ok: false, reason: 'missing_media_or_banner_creative', ...summary };
  return { ok: true, reason: null, ...summary };
}

function headersToObject(headers) {
  const out = {};
  try {
    headers?.forEach?.((value, key) => {
      out[key] = value;
    });
  } catch {
    /* ignore */
  }
  return out;
}

function safeClientHeader(value, fallback, maxLength = 240) {
  const text = String(value || '').replace(/[\r\n]/g, ' ').trim();
  return text ? text.slice(0, maxLength) : fallback;
}

async function fetchVastXml(tagUrl, { clientUserAgent = '', clientAcceptLanguage = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAST_PROXY_TIMEOUT_MS);
  const startedAt = Date.now();
  const requestHeaders = {
    Accept: 'application/xml,text/xml,*/*',
    'User-Agent': safeClientHeader(clientUserAgent, 'Mozilla/5.0 (compatible; XStreamVideos-VASTProxy/1.0)'),
  };
  const acceptLanguage = safeClientHeader(clientAcceptLanguage, '', 160);
  if (acceptLanguage) requestHeaders['Accept-Language'] = acceptLanguage;
  try {
    const response = await fetch(tagUrl, {
      signal: controller.signal,
      headers: requestHeaders,
    });
    const xml = await response.text();
    const responseTimeMs = Date.now() - startedAt;
    const responseHeaders = headersToObject(response.headers);
    const bodyBytes = Buffer.byteLength(xml || '', 'utf8');
    const debug = {
      requestUrl: tagUrl,
      requestHeaders,
      responseUrl: response.url,
      redirected: response.redirected,
      status: response.status,
      statusText: response.statusText,
      responseHeaders,
      responseTimeMs,
      bodyBytes,
      bodyPreview: String(xml || '').slice(0, 2000),
    };
    if (Buffer.byteLength(xml || '', 'utf8') > VAST_PROXY_MAX_BYTES) {
      return {
        ok: false,
        status: response.status,
        reason: 'vast_too_large',
        xml: '',
        debug,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: `http_${response.status}`,
        xml,
        debug,
      };
    }
    const analysis = analyzeVastXml(xml);
    return {
      ...analysis,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
      bytes: bodyBytes,
      xml: analysis.ok ? xml : '',
      rawXml: xml,
      debug: {
        ...debug,
        validation: analysis,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'vast_timeout' : 'vast_fetch_failed',
      message: err?.message || String(err),
      xml: '',
      debug: {
        requestUrl: tagUrl,
        requestHeaders,
        responseTimeMs: Date.now() - startedAt,
        error: {
          name: err?.name || '',
          message: err?.message || String(err),
          stack: err?.stack || '',
        },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const PLACEMENT_BY_SLOT = {
  home_after_subheader_900x250: 'home_after_subheader_900x250',
  home_feed_native: 'feed_native',
  home_mobile_inline_300x100: 'mobile_inline',
  category_feed_native: 'category_feed',
  home_bottom_900x250: 'homepage_bottom',
  home_sidebar: 'sidebar',
  home_softcore_160x600: 'home_sidebar',
  video_sidebar: 'sidebar',
  video_recommended: 'sidebar',
  creator_sidebar: 'sidebar',
  live_sidebar: 'sidebar',
  feed_sidebar: 'sidebar',
  search_sidebar: 'sidebar',
};

function placementForSlot(slotKey, slot = null) {
  if (slot?.location === 'after_subheader' || slotKey === 'home_after_subheader_900x250') return 'home_after_subheader_900x250';
  if (slot?.location === 'before_footer' || /_before_footer_900x250$/i.test(String(slotKey || ''))) return 'before_footer';
  return PLACEMENT_BY_SLOT[slotKey] || 'sidebar';
}

function isMissingTable(err) {
  return (
    err?.code === '42P01' ||
    err?.code === '42703' ||
    err?.code === 'PGRST200' ||
    err?.code === 'PGRST204' ||
    err?.code === 'PGRST205' ||
    /schema cache|does not exist/i.test(err?.message || '')
  );
}

const IMPRESSION_DEDUPE_MS = 60_000;
const impressionSeen = new Map();

function clientKey(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 80);
}

function shouldSkipDuplicateImpression(req, key) {
  const now = Date.now();
  const dedupeKey = `${clientKey(req)}:${key}`;
  const last = impressionSeen.get(dedupeKey) || 0;
  impressionSeen.set(dedupeKey, now);
  for (const [k, seenAt] of impressionSeen) {
    if (now - seenAt > IMPRESSION_DEDUPE_MS * 2) impressionSeen.delete(k);
  }
  return now - last < IMPRESSION_DEDUPE_MS;
}

function safeFormatForAd(ad, placement) {
  const raw = String(ad?.creativeType || ad?.creative_type || ad?.sourceType || '').toLowerCase();
  if (['feed', 'feed_native', 'category_feed', 'mobile_inline', 'native_card'].includes(String(placement || '')) || raw.includes('native')) return 'native';
  if (raw.includes('vast') || raw.includes('video_preroll')) return 'vast';
  return 'banner';
}

function sendPublicAdFallback(req, res, payload, err) {
  console.warn('[ads:public:fallback]', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    message: err?.message || String(err),
    code: err?.code,
  });
  res.setHeader('X-Ad-Fallback', 'true');
  return res.status(200).json({
    ...payload,
    recoverable: true,
    requestId: req.requestId,
  });
}

export async function getNextAd(req, res) {
  try {
    const settings = resolveVastSettingsFromMap(await getPlatformSettingsMap());
    if (!settings.enabled || !settings.url) {
      return res.json({ success: true, ad: null });
    }
    const placement = 'video_preroll';
    const ad = {
      id: `${settings.provider}-vast-preroll`,
      type: 'vast',
      sourceType: 'vast',
      placement,
      url: null,
      vastTagUrl: settings.url,
      skipAfterSeconds: 5,
      durationSeconds: 0,
      clickUrl: null,
      provider: settings.provider,
      zoneId: settings.provider === 'clickadilla' ? '1492236' : '5963164',
    };
    return res.json({ success: true, ad });
  } catch (err) {
    return sendPublicAdFallback(req, res, { success: true, ad: null }, err);
  }
}

export async function getVastXml(req, res) {
  const requestedUrl = String(req.query.url || '').trim();
  const tagUrl = requestedUrl || await resolvePublicVastUrl();
  const debugEnabled = req.query.debug === '1' || req.query.debug === 'true';
  res.setHeader('Cache-Control', 'no-store');

  if (!await isTrustedVastUrl(tagUrl)) {
    return res.status(400).json({
      ok: false,
      reason: 'untrusted_vast_url',
      xml: '',
    });
  }

  const result = await fetchVastXml(tagUrl, {
    clientUserAgent: req.get('user-agent') || '',
    clientAcceptLanguage: req.get('accept-language') || '',
  });
  if (!result.ok) {
    return res.status(200).json({
      ok: false,
      reason: result.reason || 'vast_unavailable',
      diagnostics: {
        status: result.status || null,
        bytes: result.bytes || 0,
        contentType: result.contentType || null,
        hasAd: Boolean(result.hasAd),
        adCount: result.adCount || 0,
        noFill: Boolean(result.noFill),
        hasWrapper: Boolean(result.hasWrapper),
        wrapperCount: result.wrapperCount || 0,
        inlineCount: result.inlineCount || 0,
        linearCount: result.linearCount || 0,
        nonLinearCount: result.nonLinearCount || 0,
        companionCount: result.companionCount || 0,
        vastAdTagUriCount: result.vastAdTagUriCount || 0,
        hasPlayableWrapper: Boolean(result.hasPlayableWrapper),
        hasBannerCreative: Boolean(result.hasBannerCreative),
        bannerResourceCount: result.bannerResourceCount || 0,
        mediaFileCount: result.mediaFileCount || 0,
        staticResourceCount: result.staticResourceCount || 0,
        iframeResourceCount: result.iframeResourceCount || 0,
        htmlResourceCount: result.htmlResourceCount || 0,
        impressionCount: result.impressionCount || 0,
        clickThroughCount: result.clickThroughCount || 0,
        duration: result.duration || '',
        skipOffset: result.skipOffset || '',
        missing: result.missing || [],
      },
      debug: debugEnabled ? { ...result.debug, responseBody: result.rawXml || '' } : undefined,
      xml: '',
    });
  }

  return res.json({
    ok: true,
    xml: result.xml,
    diagnostics: {
      status: result.status,
      bytes: result.bytes,
      contentType: result.contentType,
      adCount: result.adCount,
      noFill: Boolean(result.noFill),
      hasWrapper: Boolean(result.hasWrapper),
      wrapperCount: result.wrapperCount || 0,
      inlineCount: result.inlineCount || 0,
      linearCount: result.linearCount || 0,
      nonLinearCount: result.nonLinearCount || 0,
      companionCount: result.companionCount || 0,
      vastAdTagUriCount: result.vastAdTagUriCount || 0,
      hasPlayableWrapper: Boolean(result.hasPlayableWrapper),
      hasBannerCreative: Boolean(result.hasBannerCreative),
      bannerResourceCount: result.bannerResourceCount || 0,
      mediaFileCount: result.mediaFileCount,
      staticResourceCount: result.staticResourceCount || 0,
      iframeResourceCount: result.iframeResourceCount || 0,
      htmlResourceCount: result.htmlResourceCount || 0,
      impressionCount: result.impressionCount,
      clickThroughCount: result.clickThroughCount,
      duration: result.duration,
      skipOffset: result.skipOffset,
      missing: result.missing || [],
    },
    debug: debugEnabled ? { ...result.debug, responseBody: result.rawXml || result.xml || '' } : undefined,
  });
}

export async function getPlacementAd(req, res) {
  try {
    const { placement } = req.params;
    const seed = String(req.query.seed || req.query.slot || '');
    const excludeId = String(req.query.exclude || req.query.excludeId || '') || null;
    let ad = await getCampaignForPlacement(placement, { seed, excludeId });
    let rejected = null;
    if (ad) {
      const check = await validateAdForRender({
        placement,
        width: ad.width || 300,
        height: ad.height || 250,
        embedHtml: ad.embedHtml,
        providerSlug: ad.providerSlug || 'custom',
        format: safeFormatForAd(ad, placement),
      });
      if (!check.ok) {
        rejected = check.reason || 'policy';
        ad = null;
      }
    }
    const pool = placement === 'sidebar' ? await getSidebarPoolMeta() : null;
    return res.json({ ad, pool, rejected });
  } catch (err) {
    return sendPublicAdFallback(req, res, { ad: null, pool: null, rejected: null }, err);
  }
}

export async function getSlotAd(req, res) {
  try {
    const { slotKey } = req.params;
    const slot = await import('../services/adSlot.service.js').then((m) => m.getAdSlotByKey(slotKey));
    const placement = placementForSlot(slotKey, slot);
    const excludeId = String(req.query.exclude || '') || null;
    let customAd = await getCampaignForPlacement(placement, { seed: slotKey, excludeId });
    let rejected = null;
    if (customAd) {
      const check = await validateAdForRender({
        placement,
        width: customAd.width || 300,
        height: customAd.height || 250,
        embedHtml: customAd.embedHtml,
        providerSlug: customAd.providerSlug || 'custom',
        format: safeFormatForAd(customAd, placement),
      });
      if (!check.ok) {
        rejected = check.reason || 'policy';
        customAd = null;
      }
    }
    const plan = await resolveSlotRenderPlan(slotKey, { customAd });
    const pool = await getSidebarPoolMeta();
    return res.json({ plan, customAd, pool, rejected });
  } catch (err) {
    return sendPublicAdFallback(req, res, {
      plan: { type: 'none' },
      customAd: null,
      pool: null,
      rejected: null,
    }, err);
  }
}

export async function trackCampaignImpression(req, res) {
  try {
    const { adId } = req.params;
    if (!adId || shouldSkipDuplicateImpression(req, `campaign:${adId}`)) {
      return res.json({ ok: true, deduped: true });
    }
    if (!supabase) return res.json({ ok: true, tracked: false });
    await supabase.rpc('increment_ad_stat', { p_ad_id: adId, p_field: 'impressions' }).catch(async () => {
      const { data, error } = await supabase.from('ad_campaigns').select('impressions').eq('id', adId).maybeSingle();
      if (error && !isMissingTable(error)) throw error;
      if (data) await supabase.from('ad_campaigns').update({ impressions: Number(data.impressions || 0) + 1 }).eq('id', adId);
    });
    return res.json({ ok: true });
  } catch (err) {
    if (!isMissingTable(err)) {
      console.warn('[ads] campaign impression ignored', { adId: req.params.adId, message: err?.message || String(err), code: err?.code });
    }
    return res.json({ ok: true, tracked: false });
  }
}

export async function trackCampaignClick(req, res) {
  try {
    const { adId } = req.params;
    if (!supabase) return res.json({ ok: true });
    const { data } = await supabase.from('ad_campaigns').select('clicks,cpc,revenue_usd').eq('id', adId).maybeSingle();
    if (data) {
      const cpc = Number(data.cpc || 0);
      await supabase.from('ad_campaigns').update({
        clicks: Number(data.clicks || 0) + 1,
        revenue_usd: Number(data.revenue_usd || 0) + cpc,
      }).eq('id', adId);
    }
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
}

export async function trackSlotImpression(req, res) {
  try {
    const { slotKey } = req.params;
    if (!slotKey || shouldSkipDuplicateImpression(req, `slot:${slotKey}`)) {
      return res.json({ ok: true, deduped: true });
    }
    const slot = await getAdSlotByKey(slotKey);
    if (!slot) return res.json({ ok: true, tracked: false, reason: 'slot_not_found' });
    await incrementSlotStats(req.params.slotKey, { impressions: 1 });
    return res.json({ ok: true, tracked: true });
  } catch (err) {
    if (!isMissingTable(err)) {
      console.warn('[ads] slot impression ignored', { slotKey: req.params.slotKey, message: err?.message || String(err), code: err?.code });
    }
    return res.json({ ok: true, tracked: false });
  }
}

export async function trackSlotClick(req, res) {
  try {
    await incrementSlotStats(req.params.slotKey, { clicks: 1 });
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
}
