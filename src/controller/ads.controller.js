import { resolveSlotRenderPlan, incrementSlotStats, getAdSlotByKey } from '../services/adSlot.service.js';
import {
  getCampaignForPlacement,
  getSidebarPoolMeta,
  mapCampaignRow,
} from '../services/adCampaign.service.js';
import { supabase } from '../config/supabase.js';
import { validateAdForRender } from '../services/safeAdPolicy.service.js';

const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idzone=5933056';

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
    const placement = 'video_preroll';
    const ad = {
      id: 'exoclick-vast-5933056',
      type: 'vast',
      sourceType: 'vast',
      placement,
      url: null,
      vastTagUrl: EXOCLICK_VAST_TAG_URL,
      skipAfterSeconds: 5,
      durationSeconds: 0,
      clickUrl: null,
      provider: 'exoclick',
      zoneId: '5933056',
    };
    return res.json({ success: true, ad });
  } catch (err) {
    return sendPublicAdFallback(req, res, { success: true, ad: null }, err);
  }
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
