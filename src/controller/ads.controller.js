/**
 * Ads system — Supabase primary.
 * Campaign ads (placement-based CPC): ad_campaigns table.
 * Platform video ads (skip/category serving + admin CRUD): video_ads table.
 */

import { supabase, isConfigured } from '../config/supabase.js';
import sanitizeHtml from 'sanitize-html';
import { isAdsSchemaMissing, adsSchemaMissingPayload, tryNotifyPgrstReloadSchema } from '../utils/supabaseAdsErrors.js';

const VALID_PLACEMENTS = ['homepage_banner', 'sidebar', 'video_player', 'creator_profile', 'feed', 'trending', 'premium'];

function resolveDevice(req) {
  const q = String(req.query.device || '').trim().toLowerCase();
  if (q === 'desktop' || q === 'mobile' || q === 'all') return q;
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (/mobi|android|iphone|ipad|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}

function nowIso() {
  return new Date().toISOString();
}

function selectPlacementCandidates(supabase, placement, device, now) {
  return supabase
    .from('ad_campaigns')
    .select(
      'id, title, name, type, creative_type, embed_sanitized_html, image_url, video_url, click_url, redirect_url, description, budget, budget_usd, impressions, clicks, priority, device, start_date, expiry_date, end_date, status, is_active'
    )
    .eq('placement', placement)
    .eq('status', 'active')
    .in('device', [device, 'all'])
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`expiry_date.is.null,expiry_date.gte.${now}`)
    .order('priority', { ascending: false })
    .order('impressions', { ascending: true })
    .limit(25);
}

function sanitizeEmbed(rawHtml) {
  const html = typeof rawHtml === 'string' ? rawHtml : '';
  if (!html.trim()) return { sanitized: '', fingerprint: null };
  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      'a', 'div', 'span', 'p', 'br',
      'img',
      'iframe',
      'script',
      'ins',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      div: ['class', 'id', 'data-*', 'style'],
      span: ['class', 'id', 'data-*', 'style'],
      img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
      iframe: ['src', 'width', 'height', 'frameborder', 'scrolling', 'allow', 'allowfullscreen', 'loading', 'referrerpolicy', 'sandbox'],
      script: ['src', 'async', 'defer', 'type', 'data-*'],
      ins: ['class', 'style', 'data-*'],
      p: ['class', 'style'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
    // Block inline JS / event handlers.
    exclusiveFilter(frame) {
      const attrs = frame.attribs || {};
      for (const k of Object.keys(attrs)) {
        if (/^on/i.test(k)) return true;
      }
      const href = attrs.href || '';
      const src = attrs.src || '';
      if (typeof href === 'string' && href.trim().toLowerCase().startsWith('javascript:')) return true;
      if (typeof src === 'string' && src.trim().toLowerCase().startsWith('javascript:')) return true;
      return false;
    },
  });

  // Simple, stable fingerprint to help clients dedupe (best-effort).
  let fingerprint = null;
  try {
    const s = sanitized.replace(/\s+/g, ' ').trim();
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    fingerprint = `fp_${Math.abs(hash)}`;
  } catch {
    fingerprint = null;
  }
  return { sanitized, fingerprint };
}

/**
 * GET /api/ads/placement/:placement
 * Returns the least-served active campaign ad for a placement.
 */
export async function getAdsByPlacement(req, res) {
  try {
    const { placement } = req.params;
    if (!VALID_PLACEMENTS.includes(placement)) {
      return res.status(400).json({ error: 'Invalid placement' });
    }

    if (!isConfigured() || !supabase) {
      return res.json({ success: true, ad: null });
    }

    const device = resolveDevice(req);
    const now = nowIso();
    const lastAdId = String(req.query.lastAdId || '').trim();

    let { data, error } = await selectPlacementCandidates(supabase, placement, device, now);
    if (error && isAdsSchemaMissing(error)) {
      await tryNotifyPgrstReloadSchema(supabase);
      ({ data, error } = await selectPlacementCandidates(supabase, placement, device, now));
    }

    if (error) {
      console.error('ads.getAdsByPlacement', error.message);
      if (isAdsSchemaMissing(error)) {
        return res.json({ success: true, ad: null, ...adsSchemaMissingPayload() });
      }
      return res.json({ success: true, ad: null });
    }

    const candidates = Array.isArray(data) ? data : [];

    // Anti-repeat: avoid the last shown ad if we have options.
    const pool =
      lastAdId && candidates.length > 1
        ? candidates.filter((a) => String(a.id) !== lastAdId)
        : candidates;

    // Choose using priority-weighted random when priorities differ; else random.
    const chosen = (() => {
      if (!pool.length) return null;
      const weights = pool.map((a) => Math.max(1, Number(a.priority) || 1));
      const sum = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * sum;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return pool[i];
      }
      return pool[0];
    })();

    return res.json({
      success: true,
      ad: chosen ? {
        id:           chosen.id,
        title:        chosen.title || chosen.name || 'Sponsored',
        type:         chosen.type || 'image',
        creativeType: chosen.creative_type || chosen.type || 'image',
        embedHtml:    chosen.embed_sanitized_html || null,
        imageUrl:     chosen.image_url  || null,
        videoUrl:     chosen.video_url  || null,
        clickUrl:     chosen.click_url  || chosen.redirect_url || null,
        description:  chosen.description || null,
      } : null,
    });
  } catch (err) {
    console.error('ads.getAdsByPlacement', err?.message || err);
    return res.json({ success: true, ad: null });
  }
}

/**
 * POST /api/ads/campaign/:adId/impression
 * Increments campaign impressions (called by frontend when ad actually enters viewport).
 */
export async function trackCampaignImpression(req, res) {
  try {
    const { adId } = req.params;
    if (!adId || !supabase) return res.json({ success: true });
    const { data: ad } = await supabase
      .from('ad_campaigns')
      .select('id, impressions')
      .eq('id', adId)
      .maybeSingle();
    if (!ad) return res.json({ success: true });
    await supabase
      .from('ad_campaigns')
      .update({ impressions: (Number(ad.impressions) || 0) + 1 })
      .eq('id', adId);
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackCampaignImpression', err?.message || err);
    return res.json({ success: true });
  }
}

/**
 * POST /api/ads/campaign/:adId/click
 * Increments clicks and adds CPC revenue on the campaign row.
 */
export async function trackCampaignClick(req, res) {
  try {
    const { adId } = req.params;
    if (!adId) return res.json({ success: true });

    const { data: ad } = await supabase
      .from('ad_campaigns')
      .select('id, clicks, cpc, revenue_usd')
      .eq('id', adId)
      .single();

    if (!ad) return res.json({ success: true });

    await supabase
      .from('ad_campaigns')
      .update({
        clicks:      (Number(ad.clicks)      || 0) + 1,
        revenue_usd: (Number(ad.revenue_usd) || 0) + (Number(ad.cpc) || 0),
      })
      .eq('id', adId);

    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackCampaignClick', err?.message || err);
    return res.json({ success: true });
  }
}

// ─── Platform video ads (video_ads table) ─────────────────────────────────────

/**
 * GET /api/ads/next?category=<category>
 * Returns the next video ad to show. Falls back to env-var URL if no active ads.
 */
export async function getNextAd(req, res) {
  const fallbackVideoUrl = process.env.AD_VIDEO_URL || process.env.VITE_AD_VIDEO_URL || '';
  const fallbackAd = fallbackVideoUrl
    ? {
        id:               'env-fallback',
        type:             'video',
        url:              fallbackVideoUrl,
        skipAfterSeconds: Number(process.env.AD_SKIP_SECONDS || 5),
        durationSeconds:  0,
        clickUrl:         null,
      }
    : null;

  try {
    if (!supabase) return res.json({ success: true, ad: fallbackAd });

    const category = String(req.query.category || '').trim().toLowerCase();
    const now      = new Date().toISOString();

    const { data: ads, error } = await supabase
      .from('video_ads')
      .select('id, storage_url, type, click_url, skip_after_seconds, duration_seconds, categories, start_date, end_date, impressions')
      .eq('is_active', true)
      .or(`start_date.is.null,start_date.lte.${now}`)
      .or(`end_date.is.null,end_date.gte.${now}`)
      .order('impressions', { ascending: true });

    if (error || !ads?.length) return res.json({ success: true, ad: fallbackAd });

    // Apply category filter client-side (empty categories = global)
    const candidates = category
      ? ads.filter((a) => !a.categories?.length || a.categories.includes(category))
      : ads;

    const ad = candidates[0] || ads[0];
    if (!ad) return res.json({ success: true, ad: fallbackAd });

    return res.json({
      success: true,
      ad: {
        id:               ad.id,
        type:             ad.type             || 'video',
        url:              ad.storage_url,
        clickUrl:         ad.click_url        || null,
        skipAfterSeconds: Number(ad.skip_after_seconds ?? 5),
        durationSeconds:  Number(ad.duration_seconds   || 0),
      },
    });
  } catch (err) {
    console.error('ads.getNextAd', err?.message || err);
    return res.json({ success: true, ad: fallbackAd });
  }
}

/**
 * POST /api/ads/:adId/impression — increment impression counter.
 */
export async function trackImpression(req, res) {
  try {
    const { adId } = req.params;
    if (!adId || adId === 'env-fallback' || !supabase) return res.json({ success: true });
    await supabase.rpc('increment_ad_stat', { p_ad_id: adId, p_field: 'impressions' });
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackImpression', err?.message || err);
    return res.json({ success: true });
  }
}

/**
 * POST /api/ads/:adId/click — increment click counter.
 */
export async function trackClick(req, res) {
  try {
    const { adId } = req.params;
    if (!adId || adId === 'env-fallback' || !supabase) return res.json({ success: true });
    await supabase.rpc('increment_ad_stat', { p_ad_id: adId, p_field: 'clicks' });
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackClick', err?.message || err);
    return res.json({ success: true });
  }
}

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

/**
 * GET /api/ads — list all platform video ads (admin only).
 */
export async function listAds(req, res) {
  try {
    if (!supabase) return res.json({ success: true, data: [] });

    const { data, error } = await supabase
      .from('video_ads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const list = (data || []).map(rowToAd);
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('ads.listAds', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * POST /api/ads — create a new platform video ad (admin only).
 */
export async function createAd(req, res) {
  try {
    if (!supabase) return res.status(503).json({ error: 'Ads service unavailable' });

    const {
      type = 'video', url, clickUrl, durationSeconds = 0,
      skipAfterSeconds = 5, active = true, categories = [],
      startDate, endDate,
    } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    const { data, error } = await supabase
      .from('video_ads')
      .insert([{
        storage_url:       url,
        title:             url.split('/').pop() || 'Ad',
        type,
        click_url:         clickUrl       || null,
        duration_seconds:  Number(durationSeconds)  || 0,
        skip_after_seconds: Number(skipAfterSeconds) || 5,
        is_active:         Boolean(active),
        categories:        Array.isArray(categories) ? categories : [],
        impressions:       0,
        clicks:            0,
        start_date:        startDate || null,
        end_date:          endDate   || null,
      }])
      .select()
      .single();
    if (error) throw error;

    return res.status(201).json({ success: true, data: rowToAd(data) });
  } catch (err) {
    console.error('ads.createAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * PATCH /api/ads/:adId — update a platform video ad (admin only).
 */
export async function updateAd(req, res) {
  try {
    const { adId } = req.params;
    if (!adId)    return res.status(400).json({ error: 'adId required' });
    if (!supabase) return res.status(503).json({ error: 'Ads service unavailable' });

    const { data: existing } = await supabase
      .from('video_ads')
      .select('id')
      .eq('id', adId)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Ad not found' });

    const allowed = {
      type:              'type',
      url:               'storage_url',
      clickUrl:          'click_url',
      durationSeconds:   'duration_seconds',
      skipAfterSeconds:  'skip_after_seconds',
      active:            'is_active',
      categories:        'categories',
      startDate:         'start_date',
      endDate:           'end_date',
    };
    const updates = { updated_at: new Date().toISOString() };
    for (const [bodyKey, dbCol] of Object.entries(allowed)) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, bodyKey)) {
        updates[dbCol] = req.body[bodyKey];
      }
    }

    const { error } = await supabase.from('video_ads').update(updates).eq('id', adId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.updateAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * DELETE /api/ads/:adId — remove a platform video ad (admin only).
 */
export async function deleteAd(req, res) {
  try {
    const { adId } = req.params;
    if (!adId)    return res.status(400).json({ error: 'adId required' });
    if (!supabase) return res.status(503).json({ error: 'Ads service unavailable' });

    const { data: existing } = await supabase
      .from('video_ads')
      .select('id')
      .eq('id', adId)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Ad not found' });

    const { error } = await supabase.from('video_ads').delete().eq('id', adId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.deleteAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function rowToAd(row) {
  return {
    id:               row.id,
    type:             row.type             || 'video',
    url:              row.storage_url,
    clickUrl:         row.click_url        || null,
    durationSeconds:  Number(row.duration_seconds   || 0),
    skipAfterSeconds: Number(row.skip_after_seconds || 5),
    active:           row.is_active !== false,
    categories:       row.categories       || [],
    impressions:      Number(row.impressions || 0),
    clicks:           Number(row.clicks     || 0),
    createdAt:        row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    startDate:        row.start_date || null,
    endDate:          row.end_date   || null,
  };
}
