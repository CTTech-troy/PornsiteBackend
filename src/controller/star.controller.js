import dotenv from 'dotenv';
dotenv.config();

const cache = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour on success
const FAIL_CACHE_DURATION = 5 * 60 * 1000; // 5 min back-off after any failure
let lastFailLogTs = 0;
let backoffUntil = 0;

function isDefaultAvatar(url = '') {
  return url.includes('pornstars/default') || url === '';
}

function logOnce(msg) {
  const now = Date.now();
  if (now - lastFailLogTs >= FAIL_CACHE_DURATION) {
    lastFailLogTs = now;
    console.warn('Pornstars API:', msg);
  }
}

export async function fetchPornstars(limit = 10) {
  const now = Date.now();
  if (now < backoffUntil) return [];

  const key = `limit:${limit}`;
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < (cached.failed ? FAIL_CACHE_DURATION : CACHE_DURATION)) {
    return cached.data;
  }

  const tryScraper = async () => {
    const host = process.env.RAPIDAPI_SCRAPER_HOST;
    const key = process.env.RAPIDAPI_SCRAPER_KEY;
    if (!key || !host) return null;
    const url = `https://${host}/api/pornhub/search/pornstar?query=a&page=1`;
    const headers = { 'x-rapidapi-key': key, 'x-rapidapi-host': host, 'Content-Type': 'application/json' };
    if (process.env.RAPIDAPI_SCRAPER_API_KEY) headers['x-api-key'] = process.env.RAPIDAPI_SCRAPER_API_KEY;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      const arr = body?.data ?? body?.results ?? (Array.isArray(body) ? body : []);
      return Array.isArray(arr) ? arr.slice(0, limit).map((s, i) => ({
        star_thumb: s.thumbnail ?? s.thumbnailUrl ?? s.avatar ?? '',
        star_name: s.name ?? s.title ?? `Star ${i + 1}`,
        star_id: s.id ?? s.slug ?? `ps-${i}`,
      })).filter(s => !isDefaultAvatar(s.star_thumb)) : [];
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
  };

  if (process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST && process.env.RAPIDAPI_URL) {
    const url = `${process.env.RAPIDAPI_URL}?offset=0&limit=${limit}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const opts = {
      method: 'GET',
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': process.env.RAPIDAPI_HOST
      },
      signal: controller.signal
    };

    try {
      const res = await fetch(url, opts);
      clearTimeout(timeoutId);

      if (res.status === 429) {
        backoffUntil = Date.now() + FAIL_CACHE_DURATION;
        logOnce('rate limit (429)');
      } else if (!res.ok) {
        backoffUntil = Date.now() + FAIL_CACHE_DURATION;
        logOnce(`HTTP ${res.status}`);
      } else {
        const json = await res.json();
        const arr = Array.isArray(json) ? json : (json.data || json.results || json.stars || []);
        const filtered = Array.isArray(arr) ? arr.filter(s => !isDefaultAvatar(s.star_thumb)) : [];
        cache.set(key, { ts: Date.now(), data: filtered, failed: false });
        return filtered;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      backoffUntil = Date.now() + FAIL_CACHE_DURATION;
      const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message || err?.cause?.message || 'fetch failed');
      logOnce(msg);
    }
  }

  const scraperList = await tryScraper();
  if (scraperList && scraperList.length > 0) {
    cache.set(key, { ts: Date.now(), data: scraperList, failed: false });
    return scraperList;
  }
  cache.set(key, { ts: now, data: [], failed: true });
  return [];
}