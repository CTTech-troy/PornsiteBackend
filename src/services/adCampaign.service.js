import { supabase } from '../config/supabase.js';

const SAFE_CAMPAIGN_PLACEMENTS = new Set([
  'homepage_banner',
  'homepage_top',
  'homepage_bottom',
  'sidebar',
  'feed',
  'feed_native',
  'homepage_feed',
  'in_feed',
  'feed_side_widget',
  'mobile_inline',
  'category_feed',
  'video_page',
  'sticky_banner',
  'native_card',
  'before_footer',
]);

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
    placementType: row.placement_type || row.placement || null,
    slotKey: row.slot_key || null,
    adSize: row.ad_size || null,
    creativeType: row.creative_type || row.source_type || 'image',
    sourceType: row.source_type || 'image',
    externalPlatform: row.external_platform || null,
    embedHtml: row.embed_sanitized_html || row.embed_html || null,
    ctaText: row.cta_text || 'Learn More',
    width: row.image_width || row.width || null,
    height: row.image_height || row.height || null,
    networkVisible: Boolean(row.network_visible),
    ownership: row.ownership || 'platform',
    paymentStatus: row.payment_status || 'waived',
    priority: row.priority ?? null,
    deviceTarget: row.device_target || 'all',
    metadata: row.metadata || {},
    renderFailures: Number(row.render_failures || 0),
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
  return [];
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
  const minRequired = 3;
  const rotationSeconds = 90;
  const rows = [];
  return {
    minRequired,
    rotationSeconds,
    activeCount: rows.length,
    meetsMinimum: rows.length >= minRequired,
  };
}

export async function getNetworkPricing() {
  return {
    runAdFeeUsd: 49,
    publishFeeUsd: 0,
    sidebarMinActiveAds: 3,
    rotationSeconds: 90,
  };
}
