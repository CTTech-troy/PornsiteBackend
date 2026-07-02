import { randomUUID } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { supabase, isConfigured } from '../config/supabase.js';
import { isAdsSchemaMissing, adsSchemaMissingPayload } from '../utils/supabaseAdsErrors.js';
import { validateAdForRender } from '../services/safeAdPolicy.service.js';

function fmt(v) { return Number(v) || 0; }

const ALLOWED_STATUS = new Set(['pending', 'active', 'paused', 'rejected', 'expired']);
const SAFE_CAMPAIGN_PLACEMENTS = {
  homepage_banner: { width: 970, height: 120, format: 'banner' },
  homepage_top: { width: 900, height: 250, format: 'banner' },
  homepage_bottom: { width: 900, height: 250, format: 'banner' },
  sidebar: { width: 300, height: 250, format: 'banner' },
  feed: { width: 728, height: 90, format: 'native' },
  feed_native: { width: 300, height: 250, format: 'native' },
  homepage_feed: { width: 300, height: 250, format: 'native' },
  in_feed: { width: 300, height: 250, format: 'native' },
  feed_side_widget: { width: 300, height: 250, format: 'native' },
  mobile_inline: { width: 300, height: 100, format: 'native' },
  category_feed: { width: 300, height: 250, format: 'native' },
  video_page: { width: 300, height: 250, format: 'banner' },
  video_slider: { width: 300, height: 250, format: 'video' },
  sticky_banner: { width: 728, height: 90, format: 'banner' },
  native_card: { width: 300, height: 250, format: 'native' },
  before_footer: { width: 900, height: 250, format: 'banner' },
};

function normalizeStatusFromBody(body) {
  if (body.status != null && ALLOWED_STATUS.has(String(body.status))) return String(body.status);
  if (body.isActive === true || body.is_active === true) return 'active';
  if (body.isActive === false || body.is_active === false) return 'paused';
  return 'pending';
}

const emptyStats = () => ({
  totalImpressions: 0,
  totalClicks: 0,
  ctr: 0,
  adRevenue: 0,
  activeCampaigns: 0,
});

function sanitizeEmbed(rawHtml) {
  const html = typeof rawHtml === 'string' ? rawHtml : '';
  if (!html.trim()) return { sanitized: '', fingerprint: null };
  const sanitized = sanitizeHtml(html, {
    allowedTags: [
      'a', 'div', 'span', 'p', 'br',
      'img',
      'iframe',
      'ins',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      div: ['class', 'id', 'data-*', 'style'],
      span: ['class', 'id', 'data-*', 'style'],
      img: ['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy'],
      iframe: ['src', 'width', 'height', 'frameborder', 'scrolling', 'loading', 'referrerpolicy', 'sandbox'],
      ins: ['class', 'style', 'data-*'],
      p: ['class', 'style'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_self' }),
      iframe: sanitizeHtml.simpleTransform('iframe', {
        sandbox: 'allow-scripts',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        scrolling: 'no',
      }),
    },
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

function normalizePlacement(placement) {
  const key = String(placement || 'homepage_banner');
  return SAFE_CAMPAIGN_PLACEMENTS[key] ? key : 'homepage_banner';
}

async function validateCampaignPayload({ placement, embedHtml, width, height, creativeType }) {
  const spec = SAFE_CAMPAIGN_PLACEMENTS[placement] || SAFE_CAMPAIGN_PLACEMENTS.homepage_banner;
  const result = await validateAdForRender({
    placement,
    width: Number(width) || spec.width,
    height: Number(height) || spec.height,
    providerSlug: 'custom',
    format: String(creativeType || spec.format).toLowerCase().includes('native') ? 'native' : spec.format,
    embedHtml,
  });
  if (!result.ok) {
    const err = new Error(`Unsafe ad rejected: ${result.reason}`);
    err.status = 400;
    throw err;
  }
}

export async function listCampaigns(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.json({ campaigns: [], stats: emptyStats(), ...adsSchemaMissingPayload() });
    }

    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      if (isAdsSchemaMissing(error)) {
        return res.json({ campaigns: [], stats: emptyStats(), ...adsSchemaMissingPayload() });
      }
      return res.status(500).json({ message: error.message });
    }

    const rows = data || [];
    const totalImpressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
    const totalClicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    const totalCtr = totalImpressions ? (totalClicks / totalImpressions) : 0;
    const totalRevenue = rows.reduce((s, r) => s + fmt(r.revenue_usd), 0);

    return res.json({
      campaigns: rows,
      stats: {
        totalImpressions,
        totalClicks,
        ctr: totalCtr,
        adRevenue: totalRevenue,
        activeCampaigns: rows.filter((r) => r.status === 'active' || r.is_active === true).length,
      },
    });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || String(err) });
  }
}

export async function createCampaign(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.status(503).json(adsSchemaMissingPayload());
    }

    const body = req.body || {};
    const id = randomUUID();

    const embedHtml = typeof body.embed_html === 'string' ? body.embed_html : (typeof body.embedHtml === 'string' ? body.embedHtml : '');
    const { sanitized, fingerprint } = sanitizeEmbed(embedHtml);
    const placement = normalizePlacement(body.placement);
    const creativeType = body.creativeType || body.creative_type || (embedHtml ? 'embed' : (body.type || 'image'));
    await validateCampaignPayload({
      placement,
      embedHtml: sanitized || embedHtml,
      width: body.image_width || body.imageWidth,
      height: body.image_height || body.imageHeight,
      creativeType,
    });

    const status = normalizeStatusFromBody(body);
    const payload = {
      id,
      user_id: body.user_id || body.userId || req.admin?.user_id || req.admin?.sub || null,
      name: String(body.name || '').trim(),
      title: body.title != null ? String(body.title).trim() : null,
      description: body.description != null ? String(body.description) : null,
      placement,
      status,
      device: body.device || 'desktop',
      priority: Number(body.priority) || 1,
      start_date: body.startDate || body.start_date || null,
      expiry_date: body.expiryDate || body.expiry_date || body.endDate || body.end_date || null,
      end_date: body.endDate || body.end_date || body.expiryDate || body.expiry_date || null,
      type: body.type || 'image',
      creative_type: creativeType,
      embed_html: embedHtml || null,
      embed_sanitized_html: sanitized || null,
      script_fingerprint: fingerprint,
      image_url: body.image_url || body.imageUrl || null,
      video_url: body.video_url || body.videoUrl || null,
      click_url: body.click_url || body.clickUrl || null,
      redirect_url: body.redirect_url || body.redirectUrl || '',
      cta_text: body.cta_text || body.ctaText || 'Learn More',
      budget: fmt(body.budget ?? body.budget_usd),
      cpc: fmt(body.cpc),
      impressions: 0,
      clicks: 0,
      revenue_usd: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!payload.name) return res.status(400).json({ message: 'name is required' });

    const { data, error } = await supabase.from('ad_campaigns').insert(payload).select().single();
    if (error) {
      if (isAdsSchemaMissing(error)) return res.status(503).json(adsSchemaMissingPayload());
      return res.status(500).json({ message: error.message });
    }
    return res.status(201).json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function updateCampaign(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.status(503).json(adsSchemaMissingPayload());
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'id required' });
    const body = req.body || {};

    const updates = { updated_at: new Date().toISOString() };
    const set = (k, v) => { updates[k] = v; };

    if (Object.prototype.hasOwnProperty.call(body, 'name')) set('name', String(body.name || '').trim());
    if (Object.prototype.hasOwnProperty.call(body, 'title')) set('title', body.title != null ? String(body.title).trim() : null);
    if (Object.prototype.hasOwnProperty.call(body, 'description')) set('description', body.description != null ? String(body.description) : null);
    if (Object.prototype.hasOwnProperty.call(body, 'placement')) set('placement', normalizePlacement(body.placement));
    if (Object.prototype.hasOwnProperty.call(body, 'device')) set('device', body.device || 'desktop');
    if (Object.prototype.hasOwnProperty.call(body, 'priority')) set('priority', Number(body.priority) || 1);
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const s = String(body.status || '');
      set('status', ALLOWED_STATUS.has(s) ? s : 'pending');
    } else if (Object.prototype.hasOwnProperty.call(body, 'isActive') || Object.prototype.hasOwnProperty.call(body, 'is_active')) {
      const v = Boolean(body.isActive ?? body.is_active);
      set('status', v ? 'active' : 'paused');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'startDate') || Object.prototype.hasOwnProperty.call(body, 'start_date')) set('start_date', body.startDate || body.start_date || null);
    if (Object.prototype.hasOwnProperty.call(body, 'endDate') || Object.prototype.hasOwnProperty.call(body, 'end_date')) {
      const ed = body.endDate || body.end_date || null;
      set('end_date', ed);
      set('expiry_date', ed);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'expiryDate') || Object.prototype.hasOwnProperty.call(body, 'expiry_date')) {
      const ed = body.expiryDate || body.expiry_date || null;
      set('expiry_date', ed);
      set('end_date', ed);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'budget') || Object.prototype.hasOwnProperty.call(body, 'budget_usd')) {
      set('budget', fmt(body.budget ?? body.budget_usd));
    }
    if (Object.prototype.hasOwnProperty.call(body, 'cpc')) set('cpc', fmt(body.cpc));
    if (Object.prototype.hasOwnProperty.call(body, 'user_id') || Object.prototype.hasOwnProperty.call(body, 'userId')) {
      set('user_id', body.user_id || body.userId || null);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'cta_text') || Object.prototype.hasOwnProperty.call(body, 'ctaText')) {
      set('cta_text', body.cta_text || body.ctaText || 'Learn More');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'creativeType') || Object.prototype.hasOwnProperty.call(body, 'creative_type')) set('creative_type', body.creativeType || body.creative_type);
    if (Object.prototype.hasOwnProperty.call(body, 'image_url') || Object.prototype.hasOwnProperty.call(body, 'imageUrl')) set('image_url', body.image_url || body.imageUrl || null);
    if (Object.prototype.hasOwnProperty.call(body, 'video_url') || Object.prototype.hasOwnProperty.call(body, 'videoUrl')) set('video_url', body.video_url || body.videoUrl || null);
    if (Object.prototype.hasOwnProperty.call(body, 'click_url') || Object.prototype.hasOwnProperty.call(body, 'clickUrl')) set('click_url', body.click_url || body.clickUrl || null);
    if (Object.prototype.hasOwnProperty.call(body, 'redirect_url') || Object.prototype.hasOwnProperty.call(body, 'redirectUrl')) set('redirect_url', body.redirect_url || body.redirectUrl || null);

    if (Object.prototype.hasOwnProperty.call(body, 'embed_html') || Object.prototype.hasOwnProperty.call(body, 'embedHtml')) {
      const raw = typeof body.embed_html === 'string' ? body.embed_html : (typeof body.embedHtml === 'string' ? body.embedHtml : '');
      const { sanitized, fingerprint } = sanitizeEmbed(raw);
      set('embed_html', raw || null);
      set('embed_sanitized_html', sanitized || null);
      set('script_fingerprint', fingerprint);
      if (!updates.creative_type) set('creative_type', raw ? 'embed' : 'image');
    }

    if (
      Object.prototype.hasOwnProperty.call(body, 'placement') ||
      Object.prototype.hasOwnProperty.call(body, 'embed_html') ||
      Object.prototype.hasOwnProperty.call(body, 'embedHtml') ||
      Object.prototype.hasOwnProperty.call(body, 'creativeType') ||
      Object.prototype.hasOwnProperty.call(body, 'creative_type') ||
      Object.prototype.hasOwnProperty.call(body, 'image_width') ||
      Object.prototype.hasOwnProperty.call(body, 'imageWidth') ||
      Object.prototype.hasOwnProperty.call(body, 'image_height') ||
      Object.prototype.hasOwnProperty.call(body, 'imageHeight')
    ) {
      await validateCampaignPayload({
        placement: updates.placement || normalizePlacement(body.placement),
        embedHtml: updates.embed_sanitized_html || updates.embed_html || '',
        width: body.image_width || body.imageWidth,
        height: body.image_height || body.imageHeight,
        creativeType: updates.creative_type || body.creativeType || body.creative_type,
      });
    }

    const { data, error } = await supabase.from('ad_campaigns').update(updates).eq('id', id).select().single();
    if (error) {
      if (isAdsSchemaMissing(error)) return res.status(503).json(adsSchemaMissingPayload());
      return res.status(500).json({ message: error.message });
    }
    if (!data) return res.status(404).json({ message: 'Not found' });
    return res.json({ campaign: data });
  } catch (err) {
    return res.status(err?.status || 500).json({ message: err?.message || String(err) });
  }
}

export async function deleteCampaign(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.status(503).json(adsSchemaMissingPayload());
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'id required' });
    const { error } = await supabase.from('ad_campaigns').delete().eq('id', id);
    if (error) {
      if (isAdsSchemaMissing(error)) return res.status(503).json(adsSchemaMissingPayload());
      return res.status(500).json({ message: error.message });
    }
    return res.json({ message: 'Deleted' });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function analyticsSummary(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.json({ impressions: 0, clicks: 0, ctr: 0, ...adsSchemaMissingPayload() });
    }

    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('id, placement, impressions, clicks');
    if (error) {
      if (isAdsSchemaMissing(error)) {
        return res.json({ impressions: 0, clicks: 0, ctr: 0, ...adsSchemaMissingPayload() });
      }
      return res.status(500).json({ message: error.message });
    }
    const rows = data || [];
    const impressions = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
    const clicks = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
    const ctr = impressions ? clicks / impressions : 0;
    return res.json({ impressions, clicks, ctr });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function analyticsTop(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.json({ ads: [], ...adsSchemaMissingPayload() });
    }

    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('id, name, title, placement, impressions, clicks')
      .order('clicks', { ascending: false })
      .limit(limit);
    if (error) {
      if (isAdsSchemaMissing(error)) return res.json({ ads: [], ...adsSchemaMissingPayload() });
      return res.status(500).json({ message: error.message });
    }
    const rows = (data || []).map((r) => ({
      ...r,
      ctr: (Number(r.impressions) || 0) ? (Number(r.clicks) || 0) / (Number(r.impressions) || 0) : 0,
    }));
    return res.json({ ads: rows });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

export async function analyticsByPlacement(req, res) {
  try {
    if (!isConfigured() || !supabase) {
      return res.json({ placements: [], ...adsSchemaMissingPayload() });
    }

    const { data, error } = await supabase
      .from('ad_campaigns')
      .select('placement, impressions, clicks');
    if (error) {
      if (isAdsSchemaMissing(error)) return res.json({ placements: [], ...adsSchemaMissingPayload() });
      return res.status(500).json({ message: error.message });
    }
    const rows = data || [];
    const map = new Map();
    for (const r of rows) {
      const key = r.placement || 'unknown';
      const agg = map.get(key) || { placement: key, impressions: 0, clicks: 0, ctr: 0 };
      agg.impressions += Number(r.impressions) || 0;
      agg.clicks += Number(r.clicks) || 0;
      map.set(key, agg);
    }
    const out = Array.from(map.values()).map((r) => ({
      ...r,
      ctr: r.impressions ? r.clicks / r.impressions : 0,
    }));
    out.sort((a, b) => b.clicks - a.clicks);
    return res.json({ placements: out });
  } catch (err) {
    return res.status(500).json({ message: err?.message || String(err) });
  }
}

