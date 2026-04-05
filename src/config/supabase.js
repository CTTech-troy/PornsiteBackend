import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/** S3-compatible endpoint (e.g. for AWS SDK): SUPABASE_STORAGE_S3_URL */
const SUPABASE_STORAGE_S3_URL =
  process.env.SUPABASE_STORAGE_S3_URL ||
  (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/storage/v1/s3` : '');

const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'images';
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || 'videos';

let supabase = null;

if (typeof globalThis.fetch === 'undefined') {
  try {
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

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false },
    global: {
      headers: { 'x-application-name': 'letstream-backend' },
    },
  });
} else {
  console.warn(
    '[Supabase] Not configured: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY missing or empty. Fallback mode will be used for DB/storage where supported.'
  );
}

function isConfigured() {
  return supabase !== null;
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
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (err) {
    return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
  }
}

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
