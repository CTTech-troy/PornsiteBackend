import { supabase } from '../config/supabase.js';
import { getPlatformSettingsMap } from './platformSettings.service.js';

const SAFE_CAMPAIGN_PLACEMENTS = new Set(['homepage_banner', 'sidebar', 'feed']);

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || err?.code === 'PGRST205';
}

function hashSeed(input) {
  let hash = 0;
  const key = String(input || '');
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function mapCampaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.name || row.title || 'Sponsored',
    description: row.description || '',
    imageUrl: row.image_url || null,
    clickUrl: row.redirect_url || row.click_url || null,
    placement: row.placement,
    creativeType: row.creative_type || row.source_type || 'image',
    sourceType: row.source_type || 'image',
    externalPlatform: row.external_platform || null,
    embedHtml: row.embed_sanitized_html || row.embed_html || null,
    ctaText: row.cta_text || 'Learn More',
    width: row.image_width || null,
    height: row.image_height || null,
    networkVisible: Boolean(row.network_visible),
    ownership: row.ownership || 'platform',
    paymentStatus: row.payment_status || 'waived',
  };
}

function filterScheduled(rows) {
  const now = new Date().toISOString();
  return (rows || []).filter((row) => {
    if (row.start_date && row.start_date > now) return false;
    if (row.end_date && row.end_date < now) return false;
    if (row.expiry_date && row.expiry_date < now) return false;
    return true;
  });
}

function isBillableForServe(row) {
  const ps = row.payment_status || 'waived';
  return ps === 'waived' || ps === 'paid';
}

export async function listActiveCampaigns(placement, { networkOnly = false } = {}) {
  if (placement && !SAFE_CAMPAIGN_PLACEMENTS.has(placement)) return [];
  if (!supabase) return [];
  let query = supabase
    .from('ad_campaigns')
    .select('*')
    .eq('status', 'active')
    .eq('is_active', true)
    .order('priority', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(48);

  if (placement) query = query.eq('placement', placement);
  if (networkOnly) query = query.eq('network_visible', true);

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return filterScheduled(data || [])
    .filter((row) => SAFE_CAMPAIGN_PLACEMENTS.has(row.placement))
    .filter(isBillableForServe);
}

export function pickRotatedCampaign(rows, { seed = '', excludeId = null, rotationSeconds = 90 } = {}) {
  let pool = rows || [];
  if (excludeId && pool.length > 1) {
    pool = pool.filter((r) => r.id !== excludeId);
  }
  if (!pool.length) return null;

  const sec = Math.max(30, Number(rotationSeconds) || 90);
  const bucket = Math.floor(Date.now() / (sec * 1000));
  const idx = hashSeed(`${seed}:${bucket}`) % pool.length;
  return pool[idx] || pool[0];
}

export async function getCampaignForPlacement(placement, { seed = '', excludeId = null } = {}) {
  const pricing = await getNetworkPricing();
  const rows = await listActiveCampaigns(placement);
  const picked = pickRotatedCampaign(rows, {
    seed,
    excludeId,
    rotationSeconds: pricing.rotationSeconds,
  });
  return mapCampaignRow(picked);
}

export async function getNetworkCampaign({ seed = '', excludeId = null } = {}) {
  const pricing = await getNetworkPricing();
  const rows = await listActiveCampaigns(null, { networkOnly: true });
  const sidebarAlso = await listActiveCampaigns('sidebar', { networkOnly: true });
  const merged = [...rows];
  for (const r of sidebarAlso) {
    if (!merged.some((x) => x.id === r.id)) merged.push(r);
  }
  const picked = pickRotatedCampaign(merged, {
    seed,
    excludeId,
    rotationSeconds: pricing.rotationSeconds,
  });
  return mapCampaignRow(picked);
}

export async function getSidebarPoolMeta() {
  const settings = await getPlatformSettingsMap();
  const minRequired = Math.max(1, parseInt(settings.sidebar_min_active_ads || '3', 10) || 3);
  const rotationSeconds = Math.max(30, parseInt(settings.network_rotation_seconds || '90', 10) || 90);
  const rows = await listActiveCampaigns('sidebar');
  return {
    minRequired,
    rotationSeconds,
    activeCount: rows.length,
    meetsMinimum: rows.length >= minRequired,
  };
}

export async function getNetworkPricing() {
  const settings = await getPlatformSettingsMap();
  return {
    runAdFeeUsd: parseFloat(settings.network_partner_run_ad_fee_usd || '49') || 49,
    publishFeeUsd: parseFloat(settings.network_partner_publish_fee_usd || '0') || 0,
    sidebarMinActiveAds: parseInt(settings.sidebar_min_active_ads || '3', 10) || 3,
    rotationSeconds: parseInt(settings.network_rotation_seconds || '90', 10) || 90,
  };
}
