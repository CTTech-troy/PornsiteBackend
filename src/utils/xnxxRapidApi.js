/**
 * RapidAPI xnxx-api (xnxx-api.p.rapidapi.com) — shared fetch + mapping for /xn/best, /xn/todays-selection, etc.
 * Configure RAPIDAPI_XNXX_API_KEY (or RAPIDAPI_XNXX_KEY / RAPIDAPI_KEY) in backend .env.
 */
export function getXnxxCredentials() {
  const key =
    process.env.RAPIDAPI_XNXX_API_KEY ||
    process.env.RAPIDAPI_XNXX_KEY ||
    process.env.RAPIDAPI_KEY ||
    '';
  const host = process.env.RAPIDAPI_XNXX_HOST || 'xnxx-api.p.rapidapi.com';
  return { key, host };
}

export function isXnxxApiConfigured() {
  const { key } = getXnxxCredentials();
  return Boolean(key && key.length >= 10 && key !== 'YOUR_API_KEY');
}

function parseDurationToSeconds(val) {
  if (val == null || val === '') return 0;
  const n = Number(val);
  if (!Number.isNaN(n) && n >= 0) return Math.floor(n);
  const s = String(val).trim();
  const parts = s.split(':').map(Number);
  if (parts.length === 2 && parts.every((p) => !Number.isNaN(p))) {
    const [m, sec] = parts;
    return Math.max(0, Math.floor(m) * 60 + Math.floor(sec));
  }
  if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
    const [h, m, sec] = parts;
    return Math.max(0, Math.floor(h) * 3600 + Math.floor(m) * 60 + Math.floor(sec));
  }
  return 0;
}

function getDurationSeconds(v) {
  if (!v || typeof v !== 'object') return 0;
  const raw = v.duration ?? v.length ?? v.runtime ?? v.duration_formatted ?? v.duration_sec;
  const sec = parseDurationToSeconds(raw);
  if (sec > 0) return sec;
  return parseDurationToSeconds(v.duration) || Number(v.duration) || 0;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '0:00';
  const n = Math.floor(Number(seconds));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function extractVideosFromXnxxResponse(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;
  const list =
    data.videos ??
    data.data ??
    (data.data && Array.isArray(data.data.videos) ? data.data.videos : null) ??
    (data.data && Array.isArray(data.data) ? data.data : null) ??
    data.results ??
    data.items ??
    data.list ??
    data.contents ??
    [];
  return Array.isArray(list) ? list : [];
}

export function mapRawToHomeCard(v, index) {
  if (!v || typeof v !== 'object') return null;
  const title = v.title || v.title_clean || v.name || v.video_title || 'Video';
  const thumb =
    v.thumb ??
    v.thumbnail ??
    v.thumbnailUrl ??
    v.poster ??
    v.thumb_url ??
    v.image ??
    v.preview ??
    v.default_thumb ??
    (v.thumbs && (v.thumbs[0]?.src ?? v.thumbs[0])) ??
    (v.thumbnails && (v.thumbnails[0]?.url ?? v.thumbnails[0])) ??
    '';
  const thumbStr = typeof thumb === 'string' ? thumb : (thumb?.src ?? thumb?.url ?? thumb?.href ?? '');
  const previewUrl = v.previewVideo ?? v.preview_video ?? v.previewMp4 ?? v.preview_mp4 ?? '';
  const pageUrl = v.url ?? v.video_url ?? v.link ?? v.video_link ?? '';
  return {
    id: v.video_id ?? v.id ?? v.key ?? v.url ?? v.viewkey ?? `v-${index}-${Math.random().toString(36).slice(2)}`,
    title: String(title),
    channel: v.channelName ?? v.channel ?? v.uploader ?? v.creator ?? v.uploader_name ?? (v.pornstars && (Array.isArray(v.pornstars) ? v.pornstars[0] : v.pornstars)) ?? 'Creator',
    views: v.views ?? v.views_count ?? v.view_count ?? 0,
    thumbnail: thumbStr,
    duration: formatDuration(getDurationSeconds(v)),
    durationSeconds: getDurationSeconds(v),
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(v.video_id || v.id || title)).slice(0, 50)}`,
    videoSrc: previewUrl || pageUrl,
    previewVideo: previewUrl || undefined,
    likes: v.rating ?? '0',
    comments: '0',
    time: v.time ?? v.added ?? v.upload_date ?? '',
    description: title ? `Watch ${title}.` : 'Watch this video.',
  };
}

/**
 * GET https://{host}/xn/best?page=1
 */
export async function fetchXnxxBestPage(page = 1) {
  const { key, host } = getXnxxCredentials();
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [], raw: null };
  }
  const url = new URL(`https://${host}/xn/best`);
  url.searchParams.set('page', String(Math.max(1, parseInt(String(page), 10) || 1)));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, items: [], raw: text };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, items: [], raw: text };
    }
    const list = extractVideosFromXnxxResponse(data);
    const items = list.map((v, i) => mapRawToHomeCard(v, i)).filter(Boolean);
    return { ok: true, items, raw: data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [], raw: null };
  }
}

/**
 * GET https://{host}/xn/todays-selection (no page)
 */
/**
 * GET https://{host}/xn/search?q=&page= (path overridable via RAPIDAPI_XNXX_SEARCH_PATH)
 */
export async function fetchXnxxSearch(query, page = 1, filter = 'relevance') {
  const { key, host } = getXnxxCredentials();
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [], raw: null };
  }
  const path = process.env.RAPIDAPI_XNXX_SEARCH_PATH || '/xn/search';
  const url = new URL(`https://${host}${path.startsWith('/') ? path : `/${path}`}`);
  url.searchParams.set('q', String(query || '').trim() || 'a');
  url.searchParams.set('page', String(Math.max(1, parseInt(String(page), 10) || 1)));
  if (filter && filter !== 'relevance') url.searchParams.set('filter', filter);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, items: [], raw: text };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, items: [], raw: text };
    }
    const list = extractVideosFromXnxxResponse(data);
    const items = list.map((v, i) => mapRawToHomeCard(v, i)).filter(Boolean);
    return { ok: true, items, raw: data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [], raw: null };
  }
}

export async function fetchXnxxTodaysSelection() {
  const { key, host } = getXnxxCredentials();
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [] };
  }
  const url = `https://${host}/xn/todays-selection`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, items: [], raw: text };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, items: [], raw: text };
    }
    const list = extractVideosFromXnxxResponse(data);
    const items = list.map((v, i) => mapRawToHomeCard(v, i)).filter(Boolean);
    return { ok: true, items, raw: data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [] };
  }
}

/** Feed item shape for GET /api/videos (paginated JSON feed). */
export function homeCardToFeedVideoItem(card, index) {
  if (!card) return null;
  const duration = Number(card.durationSeconds) || 0;
  const preview = card.previewVideo ?? '';
  const page = String(card.videoSrc || '');
  return {
    id: String(card.id),
    videoUrl: preview || page,
    previewVideo: preview,
    thumbnailUrl: String(card.thumbnail || ''),
    duration,
    createdAt: new Date().toISOString(),
    title: card.title || '',
    channel: card.channel || '',
    views: card.views ?? 0,
  };
}
