import crypto from 'crypto';
import { supabase, isConfigured as isSupabaseConfigured } from '../config/supabase.js';

function isMissingPromotionsSchema(error) {
  const msg = String(error?.message || error || '');
  return (
    error?.code === 'PGRST204' ||
    error?.code === '42P01' ||
    /schema cache|promotional_campaigns|promotional_campaign_events|Could not find the table/i.test(msg)
  );
}

function nowIso() {
  return new Date().toISOString();
}

function parseBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'active'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'inactive', 'paused'].includes(normalized)) return false;
  return fallback;
}

function cleanString(value, max = 2000) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeTargeting(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeUrl(value) {
  const text = cleanString(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeCampaignPayload(input = {}, existing = {}) {
  const body = input || {};
  const payload = {};
  const set = (column, value) => {
    if (value !== undefined) payload[column] = value;
  };

  set('title', cleanString(body.title ?? existing.title, 160));
  set('description', cleanString(body.description ?? existing.description, 1200));
  set('image_url', normalizeUrl(body.image_url ?? body.imageUrl ?? existing.image_url));
  set('video_url', normalizeUrl(body.video_url ?? body.videoUrl ?? existing.video_url));
  set('cta_text', cleanString(body.cta_text ?? body.ctaText ?? existing.cta_text, 80));
  set('cta_link', normalizeUrl(body.cta_link ?? body.ctaLink ?? existing.cta_link));
  set('priority', Math.trunc(Number(body.priority ?? existing.priority ?? 0)) || 0);
  set('start_date', body.start_date ?? body.startDate ?? existing.start_date ?? null);
  set('end_date', body.end_date ?? body.endDate ?? existing.end_date ?? null);
  set('active', parseBoolean(body.active ?? body.isActive ?? existing.active, true));
  set('targeting', normalizeTargeting(body.targeting ?? existing.targeting));
  set('updated_at', nowIso());
  return payload;
}

function withDerivedStats(row) {
  const impressions = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);
  return {
    ...row,
    impressions,
    clicks,
    unique_viewers: Number(row?.unique_viewers || 0),
    ctr: impressions > 0 ? clicks / impressions : 0,
  };
}

export function hashVisitor({ userId, sessionId, ip, userAgent }) {
  const seed = [userId || '', sessionId || '', ip || '', userAgent || ''].join('|');
  return crypto.createHash('sha256').update(seed || crypto.randomUUID()).digest('hex');
}

export function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex');
}

export async function listAdminPromotionalCampaigns() {
  if (!isSupabaseConfigured() || !supabase) return { campaigns: [], stats: emptyStats(), schemaReady: false };
  const { data, error } = await supabase
    .from('promotional_campaigns')
    .select('*')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingPromotionsSchema(error)) return { campaigns: [], stats: emptyStats(), schemaReady: false };
    throw error;
  }
  const campaigns = (data || []).map(withDerivedStats);
  return { campaigns, stats: summarizeCampaigns(campaigns), schemaReady: true };
}

export async function getActivePromotionalCampaigns({ limit = 3 } = {}) {
  if (!isSupabaseConfigured() || !supabase) return { campaigns: [], schemaReady: false };
  const now = nowIso();
  const { data, error } = await supabase
    .from('promotional_campaigns')
    .select('*')
    .eq('active', true)
    .or(`start_date.is.null,start_date.lte.${now}`)
    .or(`end_date.is.null,end_date.gte.${now}`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 3, 1), 10));
  if (error) {
    if (isMissingPromotionsSchema(error)) return { campaigns: [], schemaReady: false };
    throw error;
  }
  return { campaigns: (data || []).map(withDerivedStats), schemaReady: true };
}

export async function createPromotionalCampaign(payload) {
  if (!isSupabaseConfigured() || !supabase) {
    const err = new Error('Supabase is not configured');
    err.status = 503;
    throw err;
  }
  const normalized = normalizeCampaignPayload(payload);
  if (!normalized.title) {
    const err = new Error('title is required');
    err.status = 400;
    throw err;
  }
  const row = {
    id: payload.id || crypto.randomUUID(),
    ...normalized,
    impressions: 0,
    clicks: 0,
    unique_viewers: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { data, error } = await supabase.from('promotional_campaigns').insert(row).select('*').single();
  if (error) {
    if (isMissingPromotionsSchema(error)) {
      const err = new Error('Promotional campaign migration has not been applied');
      err.status = 503;
      throw err;
    }
    throw error;
  }
  return withDerivedStats(data);
}

export async function updatePromotionalCampaign(id, patch) {
  if (!isSupabaseConfigured() || !supabase) {
    const err = new Error('Supabase is not configured');
    err.status = 503;
    throw err;
  }
  const normalized = { updated_at: nowIso() };
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  if (has('title')) normalized.title = cleanString(patch.title, 160);
  if (has('description')) normalized.description = cleanString(patch.description, 1200);
  if (has('image_url') || has('imageUrl')) normalized.image_url = normalizeUrl(patch.image_url ?? patch.imageUrl);
  if (has('video_url') || has('videoUrl')) normalized.video_url = normalizeUrl(patch.video_url ?? patch.videoUrl);
  if (has('cta_text') || has('ctaText')) normalized.cta_text = cleanString(patch.cta_text ?? patch.ctaText, 80);
  if (has('cta_link') || has('ctaLink')) normalized.cta_link = normalizeUrl(patch.cta_link ?? patch.ctaLink);
  if (has('priority')) normalized.priority = Math.trunc(Number(patch.priority ?? 0)) || 0;
  if (has('start_date') || has('startDate')) normalized.start_date = patch.start_date ?? patch.startDate ?? null;
  if (has('end_date') || has('endDate')) normalized.end_date = patch.end_date ?? patch.endDate ?? null;
  if (has('active') || has('isActive')) normalized.active = parseBoolean(patch.active ?? patch.isActive, true);
  if (has('targeting')) normalized.targeting = normalizeTargeting(patch.targeting);
  const { data, error } = await supabase
    .from('promotional_campaigns')
    .update(normalized)
    .eq('id', id)
    .select('*')
    .single();
  if (error) {
    if (isMissingPromotionsSchema(error)) {
      const err = new Error('Promotional campaign migration has not been applied');
      err.status = 503;
      throw err;
    }
    throw error;
  }
  return withDerivedStats(data);
}

export async function deletePromotionalCampaign(id) {
  if (!isSupabaseConfigured() || !supabase) return { ok: false };
  const { error } = await supabase.from('promotional_campaigns').delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

export async function recordPromotionalCampaignEvent({
  campaignId,
  eventType,
  viewerHash,
  userId,
  sessionId,
  ipHash,
  userAgent,
  metadata = {},
}) {
  if (!isSupabaseConfigured() || !supabase) return { ok: false, schemaReady: false };
  const args = {
    p_campaign_id: campaignId,
    p_event_type: eventType,
    p_viewer_hash: viewerHash || null,
    p_user_id: userId || null,
    p_session_id: sessionId || null,
    p_ip_hash: ipHash || null,
    p_user_agent: userAgent || null,
    p_metadata: metadata,
  };
  const { data, error } = await supabase.rpc('record_promotional_campaign_event', args);
  if (error) {
    if (isMissingPromotionsSchema(error)) return { ok: false, schemaReady: false };
    throw error;
  }
  return { ok: true, schemaReady: true, stats: data || {} };
}

function summarizeCampaigns(campaigns) {
  const impressions = campaigns.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
  const clicks = campaigns.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
  const uniqueViewers = campaigns.reduce((sum, row) => sum + Number(row.unique_viewers || 0), 0);
  const activeCampaigns = campaigns.filter((row) => row.active).length;
  return {
    totalCampaigns: campaigns.length,
    activeCampaigns,
    impressions,
    clicks,
    uniqueViewers,
    ctr: impressions > 0 ? clicks / impressions : 0,
  };
}

function emptyStats() {
  return {
    totalCampaigns: 0,
    activeCampaigns: 0,
    impressions: 0,
    clicks: 0,
    uniqueViewers: 0,
    ctr: 0,
  };
}

export { isMissingPromotionsSchema };
