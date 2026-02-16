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

/**
 * GET /api/videos?limit=10&offset=0
 * Supports:
 *  - PostgreSQL via DATABASE_URL env (expects table `videos` with fields: title, thumbnail, duration, url, views)
 *  - fallback to backend/data/videos.json (array of video objects)
 */
export async function getVideos(req, res) {
  const limit = clamp(parseInt(req.query.limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1, 100);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);

  try {
    // Try DB (Postgres) if DATABASE_URL present
    if (process.env.DATABASE_URL) {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const q = `
        SELECT title, thumbnail, duration, url, views
        FROM videos
        ORDER BY id DESC
        LIMIT $1 OFFSET $2
      `;
      const result = await pool.query(q, [limit, offset]);
      await pool.end();
      return res.json({
        success: true,
        data: result.rows,
        limit,
        offset,
        count: result.rows.length
      });
    }

    // Fallback: JSON file in repo
    const file = path.resolve(process.cwd(), 'backend', 'data', 'videos.json');
    const raw = await fs.readFile(file, 'utf8');
    const all = JSON.parse(raw);
    const page = Array.isArray(all) ? all.slice(offset, offset + limit) : [];
    return res.json({
      success: true,
      data: page,
      limit,
      offset,
      total: Array.isArray(all) ? all.length : 0
    });
  } catch (err) {
    console.error('getVideos error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch videos' });
  }
}