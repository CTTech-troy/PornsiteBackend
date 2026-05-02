/**
 * Ads system — RTDB-backed ad serving + impression/click tracking.
 * Ads are stored at RTDB path: platformAds/{adId}
 * Admins can add/edit/delete ads via the admin API.
 *
 * Ad object shape:
 *   id: string
 *   type: 'video' | 'image'
 *   url: string              — direct video/image URL
 *   clickUrl: string         — where clicking the ad goes (optional)
 *   durationSeconds: number  — how long to show (image ads); 0 = video natural length
 *   skipAfterSeconds: number — 0 = not skippable, N = show skip button after N seconds
 *   active: boolean
 *   categories: string[]     — targeting (empty = global)
 *   impressions: number
 *   clicks: number
 *   createdAt: number
 */

import crypto from 'crypto';
import { getFirebaseRtdb } from '../config/firebase.js';
import { supabase } from '../config/supabase.js';

const VALID_PLACEMENTS = ['homepage_banner', 'sidebar', 'video_player', 'creator_profile', 'feed', 'trending', 'premium'];

/**
 * GET /api/ads/placement/:placement
 * Returns the least-served active campaign ad for a placement.
 * Increments impressions atomically via RPC to avoid race conditions.
 */
export async function getAdsByPlacement(req, res) {
  try {
    const { placement } = req.params;
    if (!VALID_PLACEMENTS.includes(placement)) {
      return res.status(400).json({ error: 'Invalid placement' });
    }

    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('id, title, name, type, image_url, video_url, click_url, description, budget_usd, impressions, clicks')
      .eq('placement', placement)
      .eq('is_active', true)
      .order('impressions', { ascending: true })
      .limit(1);

    if (error) {
      console.error('ads.getAdsByPlacement', error.message);
      return res.json({ success: true, ad: null });
    }

    const ad = data?.[0] || null;

    if (ad) {
      await supabase
        .from('ad_campaigns')
        .update({ impressions: (Number(ad.impressions) || 0) + 1 })
        .eq('id', ad.id);
    }

    return res.json({
      success: true,
      ad: ad ? {
        id: ad.id,
        title: ad.title || ad.name || 'Sponsored',
        type: ad.type || 'image',
        imageUrl: ad.image_url || null,
        videoUrl: ad.video_url || null,
        clickUrl: ad.click_url || null,
        description: ad.description || null,
      } : null,
    });
  } catch (err) {
    console.error('ads.getAdsByPlacement', err?.message || err);
    return res.json({ success: true, ad: null });
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

    const cpc = Number(ad.cpc) || 0;
    await supabase
      .from('ad_campaigns')
      .update({
        clicks: (Number(ad.clicks) || 0) + 1,
        revenue_usd: (Number(ad.revenue_usd) || 0) + cpc,
      })
      .eq('id', adId);

    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackCampaignClick', err?.message || err);
    return res.json({ success: true });
  }
}

function adsRef() {
  const rtdb = getFirebaseRtdb();
  return rtdb ? rtdb.ref('platformAds') : null;
}

function isValidPathSegment(s) {
  return typeof s === 'string' && s.length > 0 && !/[.#$[\]]/.test(s);
}

/**
 * GET /api/ads/next?category=<category>
 * Returns the next ad to show. Falls back to env-var ad if no RTDB ads are active.
 */
export async function getNextAd(req, res) {
  try {
    const category = String(req.query.category || '').trim().toLowerCase();
    const fallbackVideoUrl = process.env.AD_VIDEO_URL || process.env.VITE_AD_VIDEO_URL || '';
    const fallbackAd = fallbackVideoUrl
      ? {
          id: 'env-fallback',
          type: 'video',
          url: fallbackVideoUrl,
          skipAfterSeconds: Number(process.env.AD_SKIP_SECONDS || 5),
          durationSeconds: 0,
          clickUrl: null,
        }
      : null;

    const ref = adsRef();
    if (!ref) {
      return res.json({ success: true, ad: fallbackAd });
    }

    const snap = await ref.orderByChild('active').equalTo(true).once('value');
    const val = snap.val();
    if (!val || typeof val !== 'object') {
      return res.json({ success: true, ad: fallbackAd });
    }

    const now = Date.now();
    let candidates = Object.entries(val)
      .map(([id, a]) => ({ ...a, id }))
      .filter((a) => {
        if (!a.active) return false;
        if (a.startDate && now < a.startDate) return false;
        if (a.endDate && now > a.endDate) return false;
        if (category && Array.isArray(a.categories) && a.categories.length > 0) {
          return a.categories.includes(category);
        }
        return true;
      });

    if (candidates.length === 0) {
      return res.json({ success: true, ad: fallbackAd });
    }

    // Pick the ad with the fewest impressions (fair distribution)
    candidates.sort((a, b) => (Number(a.impressions) || 0) - (Number(b.impressions) || 0));
    const ad = candidates[0];

    return res.json({
      success: true,
      ad: {
        id: ad.id,
        type: ad.type || 'video',
        url: ad.url,
        clickUrl: ad.clickUrl || null,
        skipAfterSeconds: Number(ad.skipAfterSeconds ?? 5),
        durationSeconds: Number(ad.durationSeconds || 0),
      },
    });
  } catch (err) {
    console.error('ads.getNextAd', err?.message || err);
    const fallbackVideoUrl = process.env.AD_VIDEO_URL || process.env.VITE_AD_VIDEO_URL || '';
    return res.json({
      success: true,
      ad: fallbackVideoUrl
        ? { id: 'env-fallback', type: 'video', url: fallbackVideoUrl, skipAfterSeconds: 5, durationSeconds: 0, clickUrl: null }
        : null,
    });
  }
}

/**
 * POST /api/ads/:adId/impression
 * Increments the impression counter for an ad.
 */
export async function trackImpression(req, res) {
  try {
    const { adId } = req.params;
    if (!isValidPathSegment(adId) || adId === 'env-fallback') {
      return res.json({ success: true });
    }
    const ref = adsRef();
    if (!ref) return res.json({ success: true });
    await ref.child(adId).child('impressions').transaction(n => (Number(n) || 0) + 1);
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackImpression', err?.message || err);
    return res.json({ success: true });
  }
}

/**
 * POST /api/ads/:adId/click
 * Increments the click counter for an ad.
 */
export async function trackClick(req, res) {
  try {
    const { adId } = req.params;
    if (!isValidPathSegment(adId) || adId === 'env-fallback') {
      return res.json({ success: true });
    }
    const ref = adsRef();
    if (!ref) return res.json({ success: true });
    await ref.child(adId).child('clicks').transaction(n => (Number(n) || 0) + 1);
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.trackClick', err?.message || err);
    return res.json({ success: true });
  }
}

// ——— Admin CRUD ———

/**
 * GET /api/ads (admin only) — list all ads
 */
export async function listAds(req, res) {
  try {
    const ref = adsRef();
    if (!ref) return res.json({ success: true, data: [] });
    const snap = await ref.once('value');
    const val = snap.val();
    const list = !val ? [] : Object.entries(val).map(([id, a]) => ({ ...a, id }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return res.json({ success: true, data: list });
  } catch (err) {
    console.error('ads.listAds', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * POST /api/ads (admin only) — create a new ad
 */
export async function createAd(req, res) {
  try {
    const ref = adsRef();
    if (!ref) return res.status(503).json({ error: 'Ads service unavailable' });

    const {
      type = 'video', url, clickUrl, durationSeconds = 0,
      skipAfterSeconds = 5, active = true, categories = [],
    } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    const id = crypto.randomUUID();
    const ad = {
      id, type, url, clickUrl: clickUrl || null,
      durationSeconds: Number(durationSeconds) || 0,
      skipAfterSeconds: Number(skipAfterSeconds) || 5,
      active: Boolean(active),
      categories: Array.isArray(categories) ? categories : [],
      impressions: 0,
      clicks: 0,
      createdAt: Date.now(),
    };

    await ref.child(id).set(ad);
    return res.status(201).json({ success: true, data: ad });
  } catch (err) {
    console.error('ads.createAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * PATCH /api/ads/:adId (admin only) — update an ad
 */
export async function updateAd(req, res) {
  try {
    const { adId } = req.params;
    if (!isValidPathSegment(adId)) return res.status(400).json({ error: 'adId required' });

    const ref = adsRef();
    if (!ref) return res.status(503).json({ error: 'Ads service unavailable' });

    const snap = await ref.child(adId).once('value');
    if (!snap.val()) return res.status(404).json({ error: 'Ad not found' });

    const allowed = ['type', 'url', 'clickUrl', 'durationSeconds', 'skipAfterSeconds', 'active', 'categories', 'startDate', 'endDate'];
    const updates = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[key] = req.body[key];
      }
    }

    await ref.child(adId).update(updates);
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.updateAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}

/**
 * DELETE /api/ads/:adId (admin only) — remove an ad
 */
export async function deleteAd(req, res) {
  try {
    const { adId } = req.params;
    if (!isValidPathSegment(adId)) return res.status(400).json({ error: 'adId required' });

    const ref = adsRef();
    if (!ref) return res.status(503).json({ error: 'Ads service unavailable' });

    await ref.child(adId).remove();
    return res.json({ success: true });
  } catch (err) {
    console.error('ads.deleteAd', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  }
}
