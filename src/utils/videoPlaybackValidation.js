const DIRECT_STREAM_EXT = /\.(mp4|m4v|webm|ogg|ogv|mov|m3u8)(\?|#|&|$)/i;
const PAGE_ONLY_PATTERNS = [
  /pornhub\.com\/view_video/i,
  /xnxx\.com\/video-/i,
  /xvideos\.com\/video/i,
  /xhamster\.com\/videos?/i,
  /redtube\.com\//i,
  /youporn\.com\/watch/i,
];
const WATCH_PAGE_PATTERNS = [
  /view_video\.php/i,
  /[?&]viewkey=/i,
  /\/watch\?/i,
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
  /vimeo\.com\/\d+/i,
  /dailymotion\.com\/video\//i,
  /\/view\//i,
];
const BLOCKED_STREAM_HOSTS = [
  /phncdn\.com$/i,
  /phprcdn\.com$/i,
  /pornhub\.com$/i,
  /xnxx\.com$/i,
  /xvideos\.com$/i,
  /xhamster\.com$/i,
  /redtube\.com$/i,
  /youporn\.com$/i,
];
const APPROVED_DIRECT_HOSTS = [
  /cloudinary\.com$/i,
  /res\.cloudinary\.com$/i,
  /amazonaws\.com$/i,
  /cloudfront\.net$/i,
  /firebasestorage\.googleapis\.com$/i,
  /bunnycdn\.com$/i,
  /b-cdn\.net$/i,
  /mux\.com$/i,
  /mux\.dev$/i,
  /supabase\.co$/i,
  /supabase\.in$/i,
  /googlevideo\.com$/i,
];
const OFFICIAL_EMBED_PATTERNS = [
  /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[a-zA-Z0-9_-]+/i,
  /^https:\/\/player\.vimeo\.com\/video\/\d+/i,
  /^https:\/\/www\.dailymotion\.com\/embed\/video\/[a-zA-Z0-9]+/i,
];

function hostname(url) {
  try {
    return new URL(String(url || '').trim()).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isSafeHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isBlockedStreamHost(url) {
  const host = hostname(url);
  return Boolean(host && BLOCKED_STREAM_HOSTS.some((pattern) => pattern.test(host)));
}

export function isKnownUnsupportedPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const value = url.trim();
  return PAGE_ONLY_PATTERNS.some((pattern) => pattern.test(value));
}

export function isApprovedEmbedUrl(url) {
  if (!isSafeHttpUrl(url)) return false;
  return OFFICIAL_EMBED_PATTERNS.some((pattern) => pattern.test(url.trim()));
}

export function isApprovedDirectHost(url) {
  const host = hostname(url);
  return Boolean(host && APPROVED_DIRECT_HOSTS.some((pattern) => pattern.test(host)));
}

export function isDirectPlayableStreamUrl(url) {
  if (!isSafeHttpUrl(url)) return false;
  const value = url.trim();
  if (isBlockedStreamHost(value)) return false;
  if (isKnownUnsupportedPageUrl(value)) return false;
  if (WATCH_PAGE_PATTERNS.some((pattern) => pattern.test(value))) return false;
  if (!isApprovedDirectHost(value)) return false;
  if (DIRECT_STREAM_EXT.test(value)) return true;
  if (/\/storage\/v1\/object\/public\//i.test(value)) return true;
  return /\/(video|videos|stream)\//i.test(value);
}

function extractIframeSrc(value) {
  if (!value || typeof value !== 'string') return '';
  const match = value.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return match?.[1]?.trim() || '';
}

function getPreviewUrl(video = {}) {
  return String(video.previewVideo || video.preview_video || '').trim();
}

function playbackCandidates(video = {}) {
  const values = [
    video.playbackUrl,
    video.playback_url,
    video.streamUrl,
    video.stream_url,
    video.storage_url,
    video.file_url,
    video.download_url,
    video.videoUrl,
    video.video_url,
    video.url,
    video.videoSrc,
  ];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function tryExternalPreviewStream(video = {}) {
  const source = String(video.source || '').toLowerCase();
  if (source !== 'external') return null;
  const preview = getPreviewUrl(video);
  if (!preview || !isDirectPlayableStreamUrl(preview)) return null;
  return {
    playable: true,
    sourceType: 'preview_stream',
    embedAllowed: false,
    validationStatus: 'playable',
    playbackUrl: preview,
    reason: '',
  };
}

export function validateVideoPlaybackSource(video = {}) {
  if (!video || typeof video !== 'object') {
    return {
      playable: false,
      sourceType: 'unknown',
      embedAllowed: false,
      validationStatus: 'invalid_video',
      playbackUrl: '',
      reason: 'Video record is missing.',
    };
  }

  if (video.playable === false || video.validationStatus === 'unsupported' || video.validation_status === 'unsupported') {
    return {
      playable: false,
      sourceType: video.sourceType || video.source_type || 'unsupported',
      embedAllowed: false,
      validationStatus: 'unsupported',
      playbackUrl: '',
      reason: 'Marked as unsupported.',
    };
  }

  if (video.validationStatus === 'probe_failed' || video.validation_status === 'probe_failed') {
    return {
      playable: false,
      sourceType: video.sourceType || video.source_type || 'blocked_embed',
      embedAllowed: false,
      validationStatus: 'probe_failed',
      playbackUrl: '',
      reason: 'Embed probe failed (X-Frame-Options or CSP).',
    };
  }

  const embedSource =
    String(video.embed_url || video.embedUrl || '').trim() ||
    extractIframeSrc(String(video.embed_code || video.embedCode || ''));
  if (embedSource) {
    if (isApprovedEmbedUrl(embedSource)) {
      return {
        playable: true,
        sourceType: 'official_embed',
        embedAllowed: true,
        validationStatus: 'playable',
        playbackUrl: embedSource,
        reason: '',
      };
    }
    return {
      playable: false,
      sourceType: 'blocked_embed',
      embedAllowed: false,
      validationStatus: 'unsupported',
      playbackUrl: '',
      reason: 'Embed URL is not on the approved provider allowlist.',
    };
  }

  const previewResult = tryExternalPreviewStream(video);
  if (previewResult) return previewResult;

  const source = String(video.source || '').toLowerCase();
  const previewUrl = getPreviewUrl(video);

  for (const candidate of playbackCandidates(video)) {
    if (source === 'external' && previewUrl && candidate === previewUrl) continue;
    if (isDirectPlayableStreamUrl(candidate)) {
      return {
        playable: true,
        sourceType: isApprovedDirectHost(candidate) ? 'approved_stream' : 'direct_stream',
        embedAllowed: false,
        validationStatus: 'playable',
        playbackUrl: candidate,
        reason: '',
      };
    }
    if (isKnownUnsupportedPageUrl(candidate) || WATCH_PAGE_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return {
        playable: false,
        sourceType: 'external_page',
        embedAllowed: false,
        validationStatus: 'unsupported',
        playbackUrl: '',
        reason: 'Source is a page URL that cannot play inside the platform.',
      };
    }
  }

  if (source === 'external' && previewUrl) {
    return tryExternalPreviewStream({ ...video, previewVideo: previewUrl }) || {
      playable: false,
      sourceType: 'external_page',
      embedAllowed: false,
      validationStatus: 'unsupported',
      playbackUrl: '',
      reason: 'Preview URL is not a playable stream on an approved host.',
    };
  }

  return {
    playable: false,
    sourceType: 'unknown',
    embedAllowed: false,
    validationStatus: 'unsupported',
    playbackUrl: '',
    reason: 'No direct stream or approved embed source found.',
  };
}

export function annotatePlayableVideo(video = {}) {
  const validation = validateVideoPlaybackSource(video);
  return {
    ...video,
    playable: validation.playable,
    sourceType: validation.sourceType,
    source_type: validation.sourceType,
    embedAllowed: validation.embedAllowed,
    embed_allowed: validation.embedAllowed,
    validationStatus: validation.validationStatus,
    validation_status: validation.validationStatus,
    playbackUrl: validation.playbackUrl,
    playback_url: validation.playbackUrl,
    unavailableReason: validation.reason || '',
  };
}

export function isPlayableVideo(video = {}) {
  return validateVideoPlaybackSource(video).playable === true;
}

export function filterPlayableVideos(videos = []) {
  return (Array.isArray(videos) ? videos : []).map(annotatePlayableVideo).filter((video) => video.playable === true);
}

/** Home/trending grid: show external API clips with thumbnail + page URL even when not inline-playable. */
export function isListableInHomeFeed(video = {}) {
  if (!video || typeof video !== 'object') return false;
  if (video.playable === true || video.listableInFeed === true) return true;
  const source = String(video.source || '').toLowerCase();
  if (source !== 'external') return false;
  const thumb = String(video.thumbnail || video.thumbnailUrl || video.thumb || '').trim();
  const pageUrl = String(
    video.videoUrl || video.pageUrl || video.externalUrl || video.videoSrc || video.url || '',
  ).trim();
  return thumb.length > 0 && isSafeHttpUrl(pageUrl);
}

export function annotateFeedListableVideo(video = {}) {
  const annotated = annotatePlayableVideo(video);
  const listable = isListableInHomeFeed(annotated);
  return {
    ...annotated,
    listableInFeed: listable,
    feedVisible: listable,
  };
}

export function filterHomeFeedVideos(videos = []) {
  return (Array.isArray(videos) ? videos : [])
    .map(annotateFeedListableVideo)
    .filter((video) => video.listableInFeed === true);
}
