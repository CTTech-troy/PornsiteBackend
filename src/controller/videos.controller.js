import fs from 'fs/promises';
import path from 'path';

const DEFAULT_LIMIT = 10;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Helper function to wait between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function ensureFetch() {
  if (typeof fetch === 'undefined') {
    try {
      // Handles both ESM and CJS environments for node-fetch
      const mod = await import('node-fetch');
      global.fetch = mod.default || mod;
    } catch (err) {
      throw new Error('fetch is not available. Run on Node 18+ or install node-fetch.');
    }
  }
}

async function fetchTrending(pageNumber, attempts = 0) {
  await ensureFetch();

  const url = `${process.env.RAPIDAPI_VIDEO_URL}?page=${pageNumber}`;
  const options = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_VIDEO_KEY,
      'x-rapidapi-host': process.env.RAPIDAPI_VIDEO_HOST
    }
  };
  
  try {
    const res = await fetch(url, options);

    // 1. Handle Rate Limiting (429)
    if (res.status === 429) {
      if (attempts < 3) {
        const wait = 2000 * Math.pow(2, attempts); // Increased base wait to 2s
        console.warn(`Rate limited on page ${pageNumber}, retry #${attempts + 1} in ${wait}ms...`);
        await sleep(wait);
        return await fetchTrending(pageNumber, attempts + 1); // Added await here
      }
      console.error(`Max retries reached for page ${pageNumber}`);
      return null;
    }

    // 2. Handle other HTTP errors
    if (!res.ok) {
      console.error(`HTTP Error ${res.status} on page ${pageNumber}`);
      return null;
    }

    // 3. Parse JSON
    return await res.json();

  } catch (error) {
    console.error(`Network error on page ${pageNumber}:`, error.message);
    return null; 
  }
}

async function loadTenPages() {
  let allVideos = [];
  console.log("--- Starting Pagination: Loading 10 pages ---");

  for (let i = 1; i <= 10; i++) {
    process.stdout.write(`Fetching page ${i}... `); // Cleaner logging

    const data = await fetchTrending(i);
    
    if (data) {
      // Check for common RapidAPI response wrappers
      const videos = data.videos || data.results || data.data || data.items || (Array.isArray(data) ? data : null);
      
      if (Array.isArray(videos) && videos.length > 0) {
        allVideos = allVideos.concat(videos);
        console.log(`Success! Found ${videos.length} videos.`);
      } else {
        console.warn(`\n[!] No videos found on page ${i}. Keys: ${Object.keys(data).join(', ')}`);
      }
    } else {
      console.log(`Failed.`);
    }

    // Safety delay to prevent hitting the rate limit in the first place
    await sleep(1000); 
  }

  console.log("---------------------------------------");
  console.log("Pagination Complete!");
  console.log("Total videos collected:", allVideos.length);
  return allVideos;
}

// Improved execution block
if (require.main === module) {
  loadTenPages()
    .then((results) => {
      if (results.length === 0) console.warn("Warning: No data was collected.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal Error:", err);
      process.exit(1);
    });
}

import * as videoService from '../services/video.service.js';

/**
 * GET /videos?limit=10&offset=0
 * Returns paginated videos (default 10).
 */
export async function getVideos(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10) || 10, 1), 100);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  try {
    // Prefer service layer if available
    if (videoService && typeof videoService.list === 'function') {
      const rows = await videoService.list({ limit, offset });

      // Log what we got from the service for debugging
      console.info(`[videos.controller] getVideos -> limit=${limit} offset=${offset} returned=${Array.isArray(rows) ? rows.length : 0}`);
      console.debug('[videos.controller] getVideos -> rows sample:', Array.isArray(rows) ? rows.slice(0, 5) : rows);

      return res.json({
        success: true,
        data: Array.isArray(rows) ? rows : [],
        limit,
        offset,
        count: Array.isArray(rows) ? rows.length : 0
      });
    }

    // If service doesn't expose list, try common names
    if (videoService && typeof videoService.fetchAll === 'function') {
      const all = await videoService.fetchAll();
      const page = Array.isArray(all) ? all.slice(offset, offset + limit) : [];

      // Log fallback data
      console.info(`[videos.controller] getVideos (fallback fetchAll) -> limit=${limit} offset=${offset} pageCount=${page.length} total=${Array.isArray(all) ? all.length : 'unknown'}`);
      console.debug('[videos.controller] getVideos -> page sample:', Array.isArray(page) ? page.slice(0, 5) : page);

      return res.json({ success: true, data: page, limit, offset, total: Array.isArray(all) ? all.length : undefined, count: page.length });
    }

    // Fallback: no service method found
    console.warn('[videos.controller] getVideos -> videos service missing expected methods (list/fetchAll)');
    return res.status(501).json({ success: false, message: 'videos service not implemented' });
  } catch (err) {
    console.error('[videos.controller] getVideos error', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch videos' });
  }
}

export async function fetchVideos({ page = 1, limit = 10 } = {}) {
  const offset = Math.max((page - 1) * limit, 0);
  const url = `${API_BASE}/videos?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`;

  try {
    const { status, body } = await fetchJson(url);
    if (status >= 400) throw new Error('Fetch videos failed ' + status);
    // Normalize: backend returns { success, data }
    const arr = Array.isArray(body) ? body : (body && body.data ? body.data : []);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error('videoService.fetchVideos error', err);
    throw err;
  }
}

export { fetchVideos };

export default {
  searchVideos,
  getTrending,
  downloadVideo,
  getVideoById,
  fetchVideos,
};