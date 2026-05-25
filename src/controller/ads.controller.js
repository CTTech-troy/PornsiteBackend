import { resolveSlotRenderPlan, incrementSlotStats } from '../services/adSlot.service.js';
import {
  getCampaignForPlacement,
  getSidebarPoolMeta,
  mapCampaignRow,
} from '../services/adCampaign.service.js';
import { supabase } from '../config/supabase.js';
import { validateAdForRender } from '../services/safeAdPolicy.service.js';

const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idzone=5933056';

const PLACEMENT_BY_SLOT = {
  home_sidebar: 'sidebar',
  video_sidebar: 'sidebar',
  video_recommended: 'sidebar',
  creator_sidebar: 'sidebar',
  live_sidebar: 'sidebar',
  feed_sidebar: 'sidebar',
  search_sidebar: 'sidebar',
};

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || err?.code === 'PGRST205';
}

function safeFormatForAd(ad, placement) {
  const raw = String(ad?.creativeType || ad?.creative_type || ad?.sourceType || '').toLowerCase();
  if (placement === 'feed' || raw.includes('native')) return 'native';
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
    const placement = 'sidebar';
    const excludeId = String(req.query.exclude || '') || null;
    let customAd = await getCampaignForPlacement(placement, { seed: slotKey, excludeId });
    let rejected = null;
    if (customAd) {
      const check = await validateAdForRender({
        placement: PLACEMENT_BY_SLOT[slotKey] || placement,
        width: customAd.width || 300,
        height: customAd.height || 250,
        embedHtml: customAd.embedHtml,
        providerSlug: customAd.providerSlug || 'custom',
        format: safeFormatForAd(customAd, PLACEMENT_BY_SLOT[slotKey] || placement),
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
    if (!supabase) return res.json({ ok: true });
    await supabase.rpc('increment_ad_stat', { p_ad_id: adId, p_field: 'impressions' }).catch(async () => {
      const { data } = await supabase.from('ad_campaigns').select('impressions').eq('id', adId).maybeSingle();
      if (data) await supabase.from('ad_campaigns').update({ impressions: Number(data.impressions || 0) + 1 }).eq('id', adId);
    });
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
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
    await incrementSlotStats(req.params.slotKey, { impressions: 1 });
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
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
