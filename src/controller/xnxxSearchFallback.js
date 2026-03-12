/**
 * Fallback: pornhub-api-xnxx POST /api/search when primary scraper is rate-limited or down.
 * Body: { q: string, pages: number }
 * Uses RAPIDAPI_TRENDING_KEY and RAPIDAPI_TRENDING_HOST (same as trending).
 */
const XNXX_HOST = process.env.RAPIDAPI_TRENDING_HOST || 'pornhub-api-xnxx.p.rapidapi.com';
const XNXX_KEY = process.env.RAPIDAPI_TRENDING_KEY || process.env.RAPIDAPI_KEY || '';

function isConfigured() {
  return Boolean(XNXX_KEY && XNXX_KEY.length >= 10 && XNXX_KEY !== 'YOUR_API_KEY');
}

function extractVideoList(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body;
  const list = body.videos ?? body.data ?? (body.data && Array.isArray(body.data.videos) ? body.data.videos : null) ?? (body.data && Array.isArray(body.data) ? body.data : null) ?? body.results ?? body.items ?? body.list ?? body.contents ?? [];
  return Array.isArray(list) ? list : [];
}

/**
 * POST https://pornhub-api-xnxx.p.rapidapi.com/api/search
 * Body: { q: string, pages: number }
 * @returns { Promise<Array> } raw video items
 */
export async function xnxxSearch(query, page = 1) {
  if (!isConfigured()) return [];
  const url = `https://${XNXX_HOST}/api/search`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-rapidapi-key': XNXX_KEY,
        'x-rapidapi-host': XNXX_HOST,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: String(query).trim() || 'trending', pages: Math.max(1, parseInt(String(page), 10) || 1) }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    return extractVideoList(data);
  } catch (err) {
    clearTimeout(timeoutId);
    return [];
  }
}

export { isConfigured as isXnxxSearchConfigured };
