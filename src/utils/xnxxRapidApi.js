/**
 * RapidAPI xnxx-api (xnxx-api.p.rapidapi.com) — /xn/best, /xn/search, /xn/todays-selection.
 * Keys: RAPIDAPI_XNXX_API_KEY or RAPIDAPI_KEY.
 * Search fallback: porn-xnxx-api.p.rapidapi.com POST /search (same key usually).
 * Env: RAPIDAPI_PORN_XNXX_HOST, RAPIDAPI_PORN_XNXX_SEARCH_PATH, SEARCH_CACHE_MS (default 120000), SEARCH_FALLBACK_ON_EMPTY.
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

// Page-level cache for /xn/best — survives 429 quota exhaustion by serving stale data
const bestPageCache = new Map(); // page -> { items, ts }
const BEST_PAGE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes fresh TTL
const BEST_PAGE_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days stale TTL (serves on 429/error)

/**
 * GET https://{host}/xn/best?page=1
 * Returns cached data on 429 or network failure so the app is never left empty.
 */
export async function fetchXnxxBestPage(page = 1) {
  const { key, host } = getXnxxCredentials();
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [], raw: null };
  }
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const cacheKey = String(pageNum);

  // Serve fresh cache immediately
  const hit = bestPageCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < BEST_PAGE_CACHE_TTL_MS) {
    return { ok: true, items: hit.items, cached: true };
  }

  const url = new URL(`https://${host}/xn/best`);
  url.searchParams.set('page', String(pageNum));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        signal: ctrl.signal,
        headers: {
          'x-rapidapi-key': key,
          'x-rapidapi-host': host,
          'Content-Type': 'application/json',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();

    if (res.status === 429) {
      // Quota exceeded — serve stale cache if available
      if (hit && hit.items?.length > 0 && Date.now() - hit.ts < BEST_PAGE_STALE_TTL_MS) {
        console.warn(`[xnxxBestPage] 429 quota exceeded for page ${pageNum}, serving stale cache (${hit.items.length} items)`);
        return { ok: true, items: hit.items, stale: true, status: 429 };
      }
      return { ok: false, status: 429, items: [], raw: text };
    }

    if (!res.ok) {
      // Other error — try stale cache
      if (hit && hit.items?.length > 0 && Date.now() - hit.ts < BEST_PAGE_STALE_TTL_MS) {
        return { ok: true, items: hit.items, stale: true, status: res.status };
      }
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

    if (items.length > 0) {
      bestPageCache.set(cacheKey, { items, ts: Date.now() });
    }
    return { ok: true, items, raw: data };
  } catch (err) {
    // Network/timeout failure — serve stale cache
    if (hit && hit.items?.length > 0 && Date.now() - hit.ts < BEST_PAGE_STALE_TTL_MS) {
      console.warn(`[xnxxBestPage] fetch error for page ${pageNum}, serving stale cache:`, err?.message || err);
      return { ok: true, items: hit.items, stale: true, error: err?.message };
    }
    return { ok: false, error: err?.message || String(err), items: [], raw: null };
  }
}

function getPornXnxxFallbackCredentials() {
  const key =
    process.env.RAPIDAPI_PORN_XNXX_API_KEY ||
    process.env.RAPIDAPI_XNXX_API_KEY ||
    process.env.RAPIDAPI_KEY ||
    '';
  const host = process.env.RAPIDAPI_PORN_XNXX_HOST || 'porn-xnxx-api.p.rapidapi.com';
  return { key, host };
}

function shouldTrySearchFallback(primary) {
  if (!primary) return true;
  if (primary.ok && primary.items?.length > 0) return false;
  if (process.env.SEARCH_FALLBACK_ON_EMPTY === '1' && primary.ok && (!primary.items || primary.items.length === 0)) {
    return true;
  }
  return !primary.ok;
}

/**
 * POST https://{host}/search — RapidAPI porn-xnxx-api (fallback when primary xnxx-api is down).
 * Body: JSON { q, page? } — override path via RAPIDAPI_PORN_XNXX_SEARCH_PATH (default /search).
 */
async function fetchPornXnxxSearchPost(query, page = 1) {
  const { key, host } = getPornXnxxFallbackCredentials();
  if (!key || key.length < 10) {
    return { ok: false, items: [], raw: null };
  }
  const path = process.env.RAPIDAPI_PORN_XNXX_SEARCH_PATH || '/search';
  const url = `https://${host}${path.startsWith('/') ? path : `/${path}`}`;
  const q = String(query || '').trim() || 'a';
  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const body = { q: q, page: p };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
    return { ok: true, items, raw: data, source: 'fallback' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [], raw: null };
  }
}

async function fetchXnxxSearchPrimary(query, page = 1, filter = 'relevance') {
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
    return { ok: true, items, raw: data, source: 'primary' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), items: [], raw: null };
  }
}

const searchCache = new Map();
const searchInFlight = new Map();

function searchCacheKey(q, page, filter) {
  return `${String(q).trim()}\t${page}\t${filter}`;
}

function getSearchCacheTtlMs() {
  const n = Number(process.env.SEARCH_CACHE_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return 120_000;
}

/**
 * GET primary (xnxx-api /xn/search), then POST fallback (porn-xnxx-api /search) if needed.
 * Same query+page+filter: one upstream chain at a time; optional TTL cache (SEARCH_CACHE_MS, default 120s).
 */
export async function fetchXnxxSearch(query, page = 1, filter = 'relevance') {
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [], raw: null };
  }
  const q = String(query || '').trim() || 'a';
  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const f =
    filter === 'relevance' || filter === 'newest' || filter === 'mostviewed' ? filter : 'relevance';
  const key = searchCacheKey(q, p, f);
  const ttl = getSearchCacheTtlMs();

  if (ttl > 0) {
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.ts < ttl) {
      return { ...hit.payload, cached: true };
    }
  }

  const existingFlight = searchInFlight.get(key);
  if (existingFlight) {
    return existingFlight;
  }

  const runPromise = new Promise((resolve) => {
    (async () => {
      try {
        const primary = await fetchXnxxSearchPrimary(q, p, f);
        if (primary.ok && primary.items?.length > 0) {
          if (ttl > 0) {
            searchCache.set(key, { ts: Date.now(), payload: { ...primary } });
          }
          resolve(primary);
          return;
        }
        if (shouldTrySearchFallback(primary)) {
          const fb = await fetchPornXnxxSearchPost(q, p);
          if (fb.ok && fb.items?.length > 0) {
            if (ttl > 0) {
              searchCache.set(key, { ts: Date.now(), payload: { ...fb } });
            }
            resolve(fb);
            return;
          }
          if (primary.ok && ttl > 0) {
            searchCache.set(key, { ts: Date.now(), payload: { ...primary } });
          }
          resolve(primary.items?.length > 0 ? primary : fb);
          return;
        }
        if (primary.ok && ttl > 0) {
          searchCache.set(key, { ts: Date.now(), payload: { ...primary } });
        }
        resolve(primary);
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e), items: [], raw: null });
      }
    })();
  });

  searchInFlight.set(key, runPromise);
  try {
    return await runPromise;
  } finally {
    searchInFlight.delete(key);
  }
}

const todaysSelectionCache = {
  items: null,
  ts: 0,
};

function getTodaysSelectionTtlMs() {
  const n = Number(process.env.TODAYS_SELECTION_CACHE_MS);
  if (Number.isFinite(n) && n >= 30_000) return n;
  return 5 * 60 * 1000;
}

export async function fetchXnxxTodaysSelection() {
  const { key, host } = getXnxxCredentials();
  if (!isXnxxApiConfigured()) {
    return { ok: false, error: 'not_configured', items: [] };
  }
  const ttl = getTodaysSelectionTtlMs();
  const now = Date.now();
  if (Array.isArray(todaysSelectionCache.items) && now - todaysSelectionCache.ts < ttl) {
    return { ok: true, items: todaysSelectionCache.items, raw: null, cached: true };
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
    if (!res.ok) {
      if (res.status === 429 && Array.isArray(todaysSelectionCache.items) && todaysSelectionCache.items.length > 0) {
        return { ok: true, items: todaysSelectionCache.items, raw: text, stale: true };
      }
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
    if (items.length > 0) {
      todaysSelectionCache.items = items;
      todaysSelectionCache.ts = Date.now();
    }
    return { ok: true, items, raw: data };
  } catch (err) {
    if (Array.isArray(todaysSelectionCache.items) && todaysSelectionCache.items.length > 0) {
      return { ok: true, items: todaysSelectionCache.items, stale: true, error: err?.message || String(err) };
    }
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
