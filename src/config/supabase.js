import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
/** S3-compatible endpoint (e.g. for AWS SDK): SUPABASE_STORAGE_S3_URL */
const SUPABASE_STORAGE_S3_URL = process.env.SUPABASE_STORAGE_S3_URL || (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/s3` : '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service-role key for server
const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'images';
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || 'videos';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Storage and DB operations will fallback.');
}

// Ensure a global fetch is available for @supabase/supabase-js (Node <18 doesn't provide fetch)
if (typeof globalThis.fetch === 'undefined') {
  try {
    // top-level await to synchronously import the polyfill before createClient runs
    const m = await import('node-fetch');
    const ff = m && (m.default || m);
    if (ff) {
      globalThis.fetch = ff;
      console.log('Polyfilled global.fetch with node-fetch');
    }
  } catch (err) {
    console.warn('Global fetch is not available and node-fetch could not be imported synchronously.');
    console.warn('Either upgrade Node to v18+ or `npm install node-fetch@2` in backend to provide a fetch polyfill.');
  }
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
  auth: { autoRefreshToken: false },
  global: {
    // prefer explicit headers on server
    headers: { 'x-application-name': 'letstream-backend' }
  }
});

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function uploadFileToBucket(bucket, destPath, file, contentType) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  let body;
  if (file.buffer) {
    body = file.buffer;
  } else if (file.path) {
    body = fs.createReadStream(file.path);
  } else {
    throw new Error('Unsupported file object for upload');
  }

  const { data, error } = await supabase.storage.from(bucket).upload(destPath, body, { contentType, upsert: false });
  if (error) throw error;
  return data;
}

function getPublicUrl(bucket, path) {
  if (!isConfigured()) return null;
  // supabase client provides getPublicUrl
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (err) {
    // fallback to manual construction
    return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
  }
}

/**
 * Ensure storage buckets exist (public for reading). Call once on app start if desired.
 * Silently skips on RLS, network, or missing-permission errors (create buckets in Dashboard if needed).
 */
async function ensureBuckets() {
  if (!isConfigured()) return;
  for (const bucket of [VIDEO_BUCKET, IMAGE_BUCKET]) {
    try {
      const { error } = await supabase.storage.createBucket(bucket, { public: true });
      if (error && error.message !== 'The resource already exists') {
        const msg = error.message || '';
        if (!/row-level security|RLS|policy|fetch failed/i.test(msg)) {
          console.warn(`Supabase bucket "${bucket}" create:`, msg);
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (!/fetch failed|timeout|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
        console.warn(`Supabase bucket "${bucket}" create:`, msg);
      }
    }
  }
}

export { supabase, isConfigured, uploadFileToBucket, getPublicUrl, ensureBuckets, IMAGE_BUCKET, VIDEO_BUCKET, SUPABASE_STORAGE_S3_URL };
