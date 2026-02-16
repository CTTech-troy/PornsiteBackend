import dotenv from 'dotenv';
dotenv.config();

const cache = new Map(); 
const CACHE_DURATION = 60 * 60 * 1000;

function isDefaultAvatar(url = '') {
  return url.includes('pornstars/default') || url === '';
}

export async function fetchPornstars(limit = 10) {
  const key = `limit:${limit}`;
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.ts) < CACHE_DURATION) {
    return cached.data;
  }

  if (!process.env.RAPIDAPI_KEY || !process.env.RAPIDAPI_HOST || !process.env.RAPIDAPI_URL) {
    throw new Error('Missing required environment variables');
  }

  const url = `${process.env.RAPIDAPI_URL}?offset=0&limit=${limit}`;
  const opts = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': process.env.RAPIDAPI_HOST
    }
  };

  try {
    const res = await fetch(url, opts);

    if (res.status === 429) {
      console.error('Rate limit exceeded (429)');
      return [];
    }
    if (!res.ok) {
      console.error('HTTP error', res.status);
      return [];
    }

    const json = await res.json();
    // support possible shapes
    const arr = Array.isArray(json) ? json : (json.data || json.results || json.stars || []);
    const filtered = Array.isArray(arr) ? arr.filter(s => !isDefaultAvatar(s.star_thumb)) : [];

    cache.set(key, { ts: Date.now(), data: filtered });
    return filtered;
  } catch (err) {
    console.error('Fetch error:', err);
    return [];
  }
}