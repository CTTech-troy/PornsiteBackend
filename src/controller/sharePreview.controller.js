import { supabase } from '../config/supabase.js';
import { fetchPublishedVideoById } from '../utils/platformPublicFeed.js';

const DEFAULT_SITE_NAME = 'XstreamVideos';
const DEFAULT_DESC = 'Watch premium videos and live streams on XstreamVideos.';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absoluteUrl(input, base) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw.startsWith('/') ? raw : `/${raw}`, base).toString();
  } catch {
    return '';
  }
}

function getFrontendOrigin(req) {
  const configured =
    String(process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || '';
  return `${proto}://${host}`.replace(/\/$/, '');
}

async function fetchVideoForPreview(videoId) {
  if (!videoId) return null;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('tiktok_videos')
        .select('video_id,title,description,thumbnail_url,creator_display_name,creator_avatar_url,status,is_live')
        .eq('video_id', videoId)
        .maybeSingle();
      if (data && (data.is_live === true || data.status === 'published')) {
        return {
          id: data.video_id,
          title: data.title || 'Video',
          description: data.description || '',
          creator: data.creator_display_name || 'Creator',
          thumbnail: data.thumbnail_url || data.creator_avatar_url || '',
        };
      }
    } catch {
      // fallback below
    }
  }

  const fallback = await fetchPublishedVideoById(videoId, null);
  if (!fallback) return null;
  return {
    id: fallback.id,
    title: fallback.title || 'Video',
    description: '',
    creator: fallback.channel || 'Creator',
    thumbnail: fallback.thumbnailUrl || '',
  };
}

function renderShareHtml({
  siteName,
  title,
  description,
  canonicalUrl,
  imageUrl,
  redirectUrl,
}) {
  const safeSite = escapeHtml(siteName);
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeCanonical = escapeHtml(canonicalUrl);
  const safeImage = escapeHtml(imageUrl);
  const safeRedirect = escapeHtml(redirectUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDesc}" />
    <link rel="canonical" href="${safeCanonical}" />

    <meta property="og:site_name" content="${safeSite}" />
    <meta property="og:type" content="video.other" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDesc}" />
    <meta property="og:url" content="${safeCanonical}" />
    <meta property="og:image" content="${safeImage}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDesc}" />
    <meta name="twitter:image" content="${safeImage}" />

    <meta http-equiv="refresh" content="0; url=${safeRedirect}" />
    <script>window.location.replace(${JSON.stringify(redirectUrl)});</script>
  </head>
  <body>
    <p>Opening video… <a href="${safeRedirect}">Continue</a></p>
  </body>
</html>`;
}

export async function renderVideoSharePreview(req, res) {
  const requestedId = String(req.params.id || '').trim();
  if (!requestedId) {
    return res.status(400).send('Missing video id');
  }

  const frontendOrigin = getFrontendOrigin(req);
  const siteName = process.env.SHARE_SITE_NAME || DEFAULT_SITE_NAME;
  const fallbackImage = absoluteUrl('/logo.jpeg', frontendOrigin);
  const redirectUrl = `${frontendOrigin}/video/${encodeURIComponent(requestedId)}`;

  const video = await fetchVideoForPreview(requestedId);
  if (!video) {
    const html = renderShareHtml({
      siteName,
      title: `${siteName} — Video`,
      description: DEFAULT_DESC,
      canonicalUrl: redirectUrl,
      imageUrl: fallbackImage,
      redirectUrl,
    });
    return res.status(200).type('html').send(html);
  }

  const previewImage = absoluteUrl(video.thumbnail, frontendOrigin) || fallbackImage;
  const title = `${video.title} · ${video.creator} | ${siteName}`.slice(0, 120);
  const description = (video.description || `${video.creator} — ${video.title}`).slice(0, 200) || DEFAULT_DESC;
  const canonicalUrl = `${frontendOrigin}/video/${encodeURIComponent(video.id || requestedId)}`;

  const html = renderShareHtml({
    siteName,
    title,
    description,
    canonicalUrl,
    imageUrl: previewImage,
    redirectUrl: canonicalUrl,
  });
  return res.status(200).type('html').send(html);
}
