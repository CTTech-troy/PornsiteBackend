import { supabase, isConfigured as isSupabaseConfigured } from '../config/supabase.js';
import { resolvePublicFrontendUrl } from '../utils/appUrls.js';

const DEFAULT_SITE_URL = 'https://xstreamvideos.site';
const VIDEO_SITEMAP_CACHE_MS = Math.max(5_000, Number(process.env.VIDEO_SITEMAP_CACHE_MS || 60_000));
const VIDEO_SITEMAP_MAX_URLS = Math.min(50_000, Math.max(1, Number(process.env.VIDEO_SITEMAP_MAX_URLS || 5_000)));

let videoSitemapCache = null;

function trimSlash(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getSiteUrl() {
  try {
    return trimSlash(resolvePublicFrontendUrl()) || DEFAULT_SITE_URL;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

function escapeXml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}...` : text;
}

function absoluteUrl(input, baseUrl) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw.startsWith('/') ? raw : `/${raw}`, baseUrl).toString();
  } catch {
    return '';
  }
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
}

function isPublicVideo(row) {
  if (!row) return false;
  if (row.deleted_at || row.deleted === true) return false;
  if (String(row.visibility || '').toLowerCase() === 'private') return false;
  return row.is_live === true || String(row.status || '').toLowerCase() === 'published';
}

function videoIdFromRow(row) {
  return String(row.video_id || row.id || '').trim();
}

function durationFromRow(row) {
  const value = Number(row.duration_seconds ?? row.duration ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(288000, Math.round(value));
}

function directContentUrl(row, siteUrl) {
  const isPremium = row.is_premium_content === true || Number(row.token_price || row.coin_price || 0) > 0;
  if (isPremium) return '';
  return absoluteUrl(row.playback_url || row.primary_url || row.stream_url || row.storage_url || row.video_url || '', siteUrl);
}

function rowToSitemapEntry(row, siteUrl) {
  const id = videoIdFromRow(row);
  if (!id || !isPublicVideo(row)) return '';

  const pageUrl = `${siteUrl}/video/${encodeURIComponent(id)}`;
  const title = truncate(row.title || 'XstreamVideos video', 100);
  const description = truncate(row.description || `${title} on XstreamVideos.`, 2048);
  const thumbnailUrl = absoluteUrl(row.thumbnail_url || row.thumbnail || '/logo.jpeg', siteUrl);
  const contentUrl = directContentUrl(row, siteUrl);
  const duration = durationFromRow(row);
  const publicationDate = toIsoDate(row.created_at || row.published_at || row.updated_at);
  const lastmod = toIsoDate(row.updated_at || row.created_at || row.published_at);
  const category = truncate(row.main_orientation_category || row.category || '', 256);
  const uploader = truncate(row.creator_display_name || row.creatorDisplayName || 'XstreamVideos creator', 255);
  const viewCount = Math.max(0, Math.round(Number(row.views_count || row.views || 0) || 0));
  const tags = parseTags(row.tags).map((tag) => truncate(tag, 32)).filter(Boolean).slice(0, 32);

  return `  <url>
    <loc>${escapeXml(pageUrl)}</loc>
    <lastmod>${escapeXml(lastmod)}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.82</priority>
    <video:video>
      <video:thumbnail_loc>${escapeXml(thumbnailUrl)}</video:thumbnail_loc>
      <video:title>${escapeXml(title)}</video:title>
      <video:description>${escapeXml(description)}</video:description>
      ${contentUrl ? `<video:content_loc>${escapeXml(contentUrl)}</video:content_loc>` : `<video:player_loc allow_embed="no">${escapeXml(pageUrl)}</video:player_loc>`}
      ${duration ? `<video:duration>${duration}</video:duration>` : ''}
      <video:publication_date>${escapeXml(publicationDate)}</video:publication_date>
      ${uploader ? `<video:uploader>${escapeXml(uploader)}</video:uploader>` : ''}
      ${category ? `<video:category>${escapeXml(category)}</video:category>` : ''}
      ${viewCount ? `<video:view_count>${viewCount}</video:view_count>` : ''}
      <video:family_friendly>no</video:family_friendly>
      ${tags.map((tag) => `<video:tag>${escapeXml(tag)}</video:tag>`).join('\n      ')}
    </video:video>
  </url>`;
}

async function fetchPublishedCreatorVideoRows(limit) {
  if (!isSupabaseConfigured() || !supabase) return [];

  const maxRows = Math.min(VIDEO_SITEMAP_MAX_URLS, Math.max(1, Number(limit) || VIDEO_SITEMAP_MAX_URLS));
  const first = await supabase
    .from('tiktok_videos')
    .select('*')
    .or('is_live.eq.true,status.eq.published')
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (!first.error) return Array.isArray(first.data) ? first.data : [];

  const message = String(first.error?.message || '');
  if (!/status|schema cache|column|does not exist/i.test(message)) {
    throw first.error;
  }

  const fallback = await supabase
    .from('tiktok_videos')
    .select('*')
    .eq('is_live', true)
    .order('created_at', { ascending: false })
    .limit(maxRows);

  if (fallback.error) throw fallback.error;
  return Array.isArray(fallback.data) ? fallback.data : [];
}

export function invalidateSeoSitemapCache(reason = 'content-change') {
  videoSitemapCache = null;
  console.info(`[seo] video sitemap cache invalidated: ${reason}`);
}

export async function buildVideoSitemapXml({ limit } = {}) {
  const siteUrl = getSiteUrl();
  const cached = videoSitemapCache;
  if (cached && Date.now() - cached.createdAt < VIDEO_SITEMAP_CACHE_MS && !limit) {
    return cached.xml;
  }

  const rows = await fetchPublishedCreatorVideoRows(limit);
  const entries = rows
    .filter(isPublicVideo)
    .map((row) => rowToSitemapEntry(row, siteUrl))
    .filter(Boolean);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${entries.join('\n')}
</urlset>
`;

  if (!limit) videoSitemapCache = { createdAt: Date.now(), xml };
  return xml;
}

export function buildSitemapIndexXml() {
  const siteUrl = getSiteUrl();
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${escapeXml(`${siteUrl}/sitemap.xml`)}</loc>
    <lastmod>${escapeXml(now)}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${escapeXml(`${siteUrl}/sitemap-videos.xml`)}</loc>
    <lastmod>${escapeXml(now)}</lastmod>
  </sitemap>
</sitemapindex>
`;
}

export async function renderVideoSitemap(req, res) {
  try {
    const limit = req.query?.limit ? Math.min(VIDEO_SITEMAP_MAX_URLS, Math.max(1, Number(req.query.limit) || 0)) : undefined;
    const xml = await buildVideoSitemapXml({ limit });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.status(200).send(xml);
  } catch (err) {
    console.error('[seo] video sitemap failed:', err?.message || err);
    return res.status(500).type('text/plain').send('Failed to build video sitemap');
  }
}

export function renderSitemapIndex(_req, res) {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  return res.status(200).send(buildSitemapIndexXml());
}
