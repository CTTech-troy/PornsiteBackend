import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import { Readable } from 'stream';

dotenv.config({ quiet: true });

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/** S3-compatible endpoint (e.g. for AWS SDK): SUPABASE_STORAGE_S3_URL */
const SUPABASE_STORAGE_S3_URL =
  process.env.SUPABASE_STORAGE_S3_URL ||
  (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/storage/v1/s3` : '');

const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'images';
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || 'videos';
const IMPORT_STAGING_BUCKET = process.env.IMPORT_STAGING_BUCKET || 'imports-staging';
const MB = 1024 * 1024;
const GB = 1024 * MB;

function readByteLimit(byteEnvName, mbEnvName, fallbackBytes) {
  const rawBytes = Number(process.env[byteEnvName] || 0);
  if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.round(rawBytes);
  const rawMb = Number(process.env[mbEnvName] || 0);
  if (Number.isFinite(rawMb) && rawMb > 0) return Math.round(rawMb * MB);
  return fallbackBytes;
}

const VIDEO_BUCKET_FILE_SIZE_LIMIT_BYTES = readByteLimit(
  'SUPABASE_VIDEO_BUCKET_FILE_SIZE_LIMIT_BYTES',
  'SUPABASE_VIDEO_BUCKET_FILE_SIZE_LIMIT_MB',
  readByteLimit('MAX_VIDEO_UPLOAD_BYTES', 'MAX_VIDEO_UPLOAD_MB', GB),
);
const IMAGE_BUCKET_FILE_SIZE_LIMIT_BYTES = readByteLimit(
  'SUPABASE_IMAGE_BUCKET_FILE_SIZE_LIMIT_BYTES',
  'SUPABASE_IMAGE_BUCKET_FILE_SIZE_LIMIT_MB',
  readByteLimit('MAX_THUMBNAIL_UPLOAD_BYTES', 'MAX_THUMBNAIL_UPLOAD_MB', GB),
);

let supabase = null;
let supabaseUnavailableUntil = 0;
let supabaseLastWarnAt = 0;

const SUPABASE_NETWORK_COOLDOWN_MS = Math.max(
  30000,
  Number(process.env.SUPABASE_NETWORK_COOLDOWN_MS || 120000)
);

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

// Wrap fetch with a per-request timeout so hung Supabase connections fail fast
// rather than blocking Node for minutes. Storage uploads are excluded (they
// pass their own signal) so large files still work.
const SUPABASE_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS || '20000', 10);

function isSupabaseNetworkError(err) {
  const msg = String(err?.message || err?.cause?.message || err || '');
  return /fetch failed|AbortError|timeout|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|network/i.test(msg);
}

function markSupabaseUnavailable(err, context = 'Supabase', { log = false } = {}) {
  if (!isSupabaseNetworkError(err)) return false;
  supabaseUnavailableUntil = Date.now() + SUPABASE_NETWORK_COOLDOWN_MS;
  if (log) {
    const now = Date.now();
    if (!supabaseLastWarnAt || now - supabaseLastWarnAt > SUPABASE_NETWORK_COOLDOWN_MS) {
      supabaseLastWarnAt = now;
      console.warn(
        `[Supabase] Temporarily unreachable during ${context}: ${err?.message || err}. ` +
        `Skipping optional Supabase calls for ${Math.ceil(SUPABASE_NETWORK_COOLDOWN_MS / 1000)}s.`
      );
    }
  }
  return true;
}

function isSupabaseAvailable() {
  return supabase !== null && Date.now() >= supabaseUnavailableUntil;
}

function getSupabaseStatus() {
  if (!supabase) return { configured: false, available: false, cooldownUntil: null };
  const cooldownUntil = Date.now() < supabaseUnavailableUntil
    ? new Date(supabaseUnavailableUntil).toISOString()
    : null;
  return {
    configured: true,
    available: !cooldownUntil,
    cooldownUntil,
  };
}

function supabaseFetch(url, options = {}) {
  // Skip timeout for storage uploads (they can be legitimately slow)
  // and for requests that already carry an abort signal.
  const urlStr = typeof url === 'string' ? url : (url?.toString?.() || '');
  const isStorageOp = urlStr.includes('/storage/v1/object');
  if (options.signal || isStorageOp) {
    return (globalThis.fetch)(url, options).catch((err) => {
      markSupabaseUnavailable(err, 'HTTP request');
      throw err;
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUPABASE_TIMEOUT_MS);
  return (globalThis.fetch)(url, { ...options, signal: ctrl.signal })
    .catch((err) => {
      markSupabaseUnavailable(err, 'HTTP request');
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

if (supabaseUrl && supabaseServiceRoleKey) {
  supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false },
    global: {
      headers: { 'x-application-name': 'letstream-backend' },
      fetch: supabaseFetch,
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
  let streamUpload = false;
  if (file?.buffer) {
    body = file.buffer;
  } else if (file?.path) {
    body = fs.createReadStream(file.path);
    streamUpload = true;
  } else if (file?.stream) {
    body = file.stream;
    streamUpload = true;
  } else if (file?.body) {
    body = file.body;
    streamUpload = typeof file.body?.pipe === 'function';
  } else if (Buffer.isBuffer(file) || typeof file === 'string') {
    body = file;
  } else {
    throw new Error('Unsupported file object for upload');
  }

  if (streamUpload) {
    const url = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodeStoragePath(destPath)}`;
    const res = await supabaseFetch(url, {
      method: 'POST',
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': contentType || 'application/octet-stream',
        ...(file?.upsert === true ? { 'x-upsert': 'true' } : {}),
      },
      body,
      duplex: 'half',
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }
    if (!res.ok) {
      const message = typeof data === 'object' && data ? (data.message || data.error || JSON.stringify(data)) : String(data || '');
      throw new Error(`Storage upload failed (${res.status}): ${message || destPath}`);
    }
    return data || { path: destPath };
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(destPath, body, {
      contentType,
      upsert: file?.upsert === true,
    });
  if (error) throw error;
  return data;
}

function encodeStoragePath(path) {
  return String(path || '').split('/').map(encodeURIComponent).join('/');
}

async function downloadFileFromBucketStream(bucket, sourcePath) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const url = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${encodeStoragePath(sourcePath)}`;
  const res = await supabaseFetch(url, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
    },
  });
  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(`Storage download failed (${res.status}): ${message || sourcePath}`);
  }
  if (!res.body) throw new Error('Storage download returned an empty stream');
  const stream = typeof Readable.fromWeb === 'function'
    ? Readable.fromWeb(res.body)
    : res.body;
  return {
    stream,
    contentLength: Number(res.headers.get('content-length') || 0) || null,
    contentType: res.headers.get('content-type') || null,
  };
}

function getPublicUrl(bucket, path) {
  if (!isConfigured()) return null;
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (err) {
    const publicPath = String(path || '').split('/').map(encodeURIComponent).join('/');
    return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${publicPath}`;
  }
}

function isBucketAlreadyExistsError(error) {
  return /resource already exists|bucket already exists|already exists|duplicate/i.test(String(error?.message || error || ''));
}

async function ensureStorageBucket(bucket, { public: isPublic = false, fileSizeLimit = null, allowedMimeTypes = undefined } = {}) {
  if (!isConfigured()) return false;
  try {
    const bucketOptions = {
      public: isPublic,
      ...(fileSizeLimit ? { fileSizeLimit } : {}),
      ...(allowedMimeTypes !== undefined ? { allowedMimeTypes } : {}),
    };
    const { error } = await supabase.storage.createBucket(bucket, bucketOptions);
    const alreadyExists = error && isBucketAlreadyExistsError(error);
    if (error && !alreadyExists) {
      const msg = error.message || '';
      if (!/row-level security|RLS|policy|fetch failed/i.test(msg)) {
        console.warn(`Supabase bucket "${bucket}" create:`, msg);
      }
    }
    if (!error || alreadyExists) {
      const { error: updateError } = await supabase.storage.updateBucket(bucket, bucketOptions);
      if (updateError && !/row-level security|RLS|policy|fetch failed/i.test(updateError.message || '')) {
        console.warn(`Supabase bucket "${bucket}" update:`, updateError.message || updateError);
      }
    }
    const { error: readError } = await supabase.storage.getBucket(bucket);
    return !readError;
  } catch (err) {
    const msg = err?.message || String(err);
    if (!/fetch failed|timeout|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      console.warn(`Supabase bucket "${bucket}" create:`, msg);
    }
    return false;
  }
}

async function ensureBuckets() {
  if (!isConfigured()) return;
  await ensureStorageBucket(VIDEO_BUCKET, {
    public: false,
    fileSizeLimit: VIDEO_BUCKET_FILE_SIZE_LIMIT_BYTES,
    allowedMimeTypes: null,
  });
  await ensureStorageBucket(IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: IMAGE_BUCKET_FILE_SIZE_LIMIT_BYTES,
    allowedMimeTypes: null,
  });
  await ensureStorageBucket(IMPORT_STAGING_BUCKET, { public: false });
}

export {
  supabase,
  isConfigured,
  isSupabaseAvailable,
  isSupabaseNetworkError,
  markSupabaseUnavailable,
  getSupabaseStatus,
  uploadFileToBucket,
  downloadFileFromBucketStream,
  getPublicUrl,
  ensureStorageBucket,
  ensureBuckets,
  IMAGE_BUCKET,
  VIDEO_BUCKET,
  IMPORT_STAGING_BUCKET,
  VIDEO_BUCKET_FILE_SIZE_LIMIT_BYTES,
  IMAGE_BUCKET_FILE_SIZE_LIMIT_BYTES,
  SUPABASE_STORAGE_S3_URL,
};
