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
const IMPORTED_SOURCE_VALUES = new Set([
  'imported_csv',
  'imported',
  'external_catalog',
  'official_import',
  'csv_import',
]);

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

export function isImportedCatalogSource(video = {}) {
  if (!video || typeof video !== 'object') return false;
  const source = String(video.source || video.contentSource || video.content_source || '').trim().toLowerCase();
  const sourceType = String(video.sourceType || video.source_type || '').trim().toLowerCase();
  return (
    IMPORTED_SOURCE_VALUES.has(source) ||
    IMPORTED_SOURCE_VALUES.has(sourceType) ||
    (sourceType.includes('imported') && sourceType.includes('stream'))
  );
}

export function isDirectPlayableStreamUrl(url, options = {}) {
  if (!isSafeHttpUrl(url)) return false;
  const value = url.trim();
  if (isBlockedStreamHost(value)) return false;
  if (isKnownUnsupportedPageUrl(value)) return false;
  if (WATCH_PAGE_PATTERNS.some((pattern) => pattern.test(value))) return false;
  const allowUnapprovedDirectHost = options.allowUnapprovedDirectHost === true;
  if (!isApprovedDirectHost(value) && !allowUnapprovedDirectHost) return false;
  if (DIRECT_STREAM_EXT.test(value)) return true;
  if (/\/storage\/v1\/object\/public\//i.test(value)) return true;
  return isApprovedDirectHost(value) && /\/(video|videos|stream)\//i.test(value);
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

function directStreamCandidates(video = {}) {
  const values = [
    video.playbackUrl,
    video.playback_url,
    video.streamUrl,
    video.stream_url,
    video.storage_url,
    video.file_url,
    video.download_url,
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

  const importedCatalogSource = isImportedCatalogSource(video);
  const rawPlaybackType = String(video.playback_type || video.playbackType || '').trim().toLowerCase();
  const iframeEmbed = String(video.iframe_embed || video.iframeEmbed || '').trim();
  const playbackType = iframeEmbed ? 'external_embed' : rawPlaybackType;
  const sourceType = String(video.sourceType || video.source_type || '').toLowerCase();
  const allowImportedDirectHost = importedCatalogSource || sourceType.includes('imported');
  const markedUnsupported =
    video.playable === false ||
    video.validationStatus === 'unsupported' ||
    video.validation_status === 'unsupported';
  if (markedUnsupported && !importedCatalogSource) {
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

  const previewUrl = getPreviewUrl(video);
  for (const candidate of directStreamCandidates(video)) {
    if (previewUrl && candidate === previewUrl) continue;
    if (isDirectPlayableStreamUrl(candidate, { allowUnapprovedDirectHost: allowImportedDirectHost })) {
      return {
        playable: true,
        sourceType: isApprovedDirectHost(candidate) ? 'approved_stream' : 'imported_direct_stream',
        embedAllowed: false,
        validationStatus: 'playable',
        playbackUrl: candidate,
        externalUrl: '',
        reason: '',
      };
    }
  }

  if (iframeEmbed && (importedCatalogSource || playbackType === 'external_embed')) {
    return {
      playable: true,
      sourceType: 'external_embed',
      embedAllowed: true,
      validationStatus: 'playable',
      playbackUrl: extractIframeSrc(iframeEmbed) || '',
      reason: '',
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
    if (importedCatalogSource || playbackType === 'external_embed') {
      return {
        playable: true,
        sourceType: 'external_embed',
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

  for (const candidate of playbackCandidates(video)) {
    if (source === 'external' && previewUrl && candidate === previewUrl) continue;
    if (isDirectPlayableStreamUrl(candidate, { allowUnapprovedDirectHost: allowImportedDirectHost })) {
      return {
        playable: true,
        sourceType: isApprovedDirectHost(candidate) ? 'approved_stream' : 'imported_direct_stream',
        embedAllowed: false,
        validationStatus: 'playable',
        playbackUrl: candidate,
        externalUrl: '',
        reason: '',
      };
    }
    if (isKnownUnsupportedPageUrl(candidate) || WATCH_PAGE_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return {
        playable: false,
        sourceType: 'external_page',
        embedAllowed: false,
        validationStatus: 'external_page',
        playbackUrl: '',
        externalUrl: candidate,
        reason: 'Source is a page URL that cannot play inside the platform.',
      };
    }
  }

  if (importedCatalogSource) {
    const candidate = playbackCandidates(video).find((value) => isSafeHttpUrl(value));
    if (candidate) {
      return {
        playable: false,
        sourceType: 'external_page',
        embedAllowed: false,
        validationStatus: 'external_page',
        playbackUrl: '',
        externalUrl: candidate,
        reason: 'Imported source is a webpage URL and must open on the source site.',
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
  const externalUrl = validation.externalUrl || video.externalUrl || video.external_url || video.pageUrl || video.page_url || '';
  const publicVideoUrl = String(
    video.videoUrl ||
    video.video_url ||
    video.streamUrl ||
    video.stream_url ||
    video.storage_url ||
    video.playbackUrl ||
    video.playback_url ||
    ''
  ).trim();
  const thumbnailUrl = video.thumbnailUrl || video.thumbnail_url || video.thumbnail || null;
  const existingPlaybackType = String(video.playbackType || video.playback_type || '').trim().toLowerCase();
  const playbackType = (
    validation.sourceType === 'external_embed' ||
    validation.sourceType === 'official_embed'
      ? 'external_embed'
      : validation.playable
        ? 'internal'
        : existingPlaybackType || (validation.validationStatus === 'external_page' ? 'external_redirect' : '')
  );
  return {
    ...video,
    videoUrl: publicVideoUrl || video.videoUrl || video.video_url || '',
    video_url: publicVideoUrl || video.video_url || video.videoUrl || '',
    iframeEmbed: video.iframeEmbed || video.iframe_embed || '',
    iframe_embed: video.iframe_embed || video.iframeEmbed || '',
    playbackType,
    playback_type: playbackType,
    thumbnailUrl,
    thumbnail_url: thumbnailUrl,
    duration: video.duration ?? video.durationSeconds ?? video.duration_seconds ?? 0,
    playable: validation.playable,
    sourceType: validation.sourceType,
    source_type: validation.sourceType,
    embedAllowed: validation.embedAllowed,
    embed_allowed: validation.embedAllowed,
    validationStatus: validation.validationStatus,
    validation_status: validation.validationStatus,
    playbackUrl: validation.playbackUrl,
    playback_url: validation.playbackUrl,
    externalUrl,
    external_url: externalUrl,
    pageUrl: externalUrl || video.pageUrl || video.page_url || '',
    page_url: externalUrl || video.page_url || video.pageUrl || '',
    unavailableReason: validation.reason || '',
  };
}

export function isPlayableVideo(video = {}) {
  return validateVideoPlaybackSource(video).playable === true;
}

export function filterPlayableVideos(videos = []) {
  return (Array.isArray(videos) ? videos : []).map(annotatePlayableVideo).filter((video) => video.playable === true);
}

/** Home/trending grid: only show videos that can play inside the platform. */
export function isListableInHomeFeed(video = {}) {
  if (!video || typeof video !== 'object') return false;
  if (video.listableInFeed === true || video.feedVisible === true) return true;
  const source = String(video.source || video.contentSource || video.content_source || '').toLowerCase();
  const thumbnail = String(video.thumbnail || video.thumbnailUrl || video.thumbnail_url || '').trim();
  const url = String(video.videoUrl || video.video_url || video.videoSrc || video.pageUrl || video.externalUrl || video.url || '').trim();
  if (
    ['imported_csv', 'imported', 'external_catalog'].includes(source) &&
    thumbnail &&
    isSafeHttpUrl(url)
  ) {
    return true;
  }
  return video.playable === true;
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
