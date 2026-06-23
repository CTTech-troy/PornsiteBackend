import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import {
  downloadFileFromBucketStream,
  getSupabaseStatus,
  isConfigured as isSupabaseConfigured,
  isSupabaseAvailable,
  supabase,
} from '../config/supabase.js';
import { resolvePublicApiUrl } from '../utils/appUrls.js';

function trim(value) {
  return String(value || '').trim();
}

function readR2MediaEnv() {
  const accountId = trim(process.env.CLOUDFLARE_R2_ACCOUNT_ID);
  return {
    accountId,
    endpoint: trim(process.env.CLOUDFLARE_R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, ''),
    accessKeyId: trim(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID),
    secretAccessKey: trim(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY),
    bucket: trim(
      process.env.CLOUDFLARE_R2_MEDIA_BUCKET ||
      process.env.CLOUDFLARE_R2_BACKUP_BUCKET ||
      process.env.CLOUDFLARE_R2_IMPORT_BUCKET
    ),
    publicBaseUrl: trim(
      process.env.CLOUDFLARE_R2_MEDIA_PUBLIC_URL ||
      process.env.CLOUDFLARE_R2_BACKUP_PUBLIC_URL ||
      process.env.CLOUDFLARE_R2_PUBLIC_URL
    ).replace(/\/+$/, ''),
    region: trim(process.env.CLOUDFLARE_R2_REGION) || 'auto',
  };
}

function getMissingR2MediaEnvVars() {
  const env = readR2MediaEnv();
  const missing = [];
  if (!env.accountId && !env.endpoint) missing.push('CLOUDFLARE_R2_ACCOUNT_ID or CLOUDFLARE_R2_ENDPOINT');
  if (!env.accessKeyId) missing.push('CLOUDFLARE_R2_ACCESS_KEY_ID');
  if (!env.secretAccessKey) missing.push('CLOUDFLARE_R2_SECRET_ACCESS_KEY');
  if (!env.bucket) missing.push('CLOUDFLARE_R2_MEDIA_BUCKET or CLOUDFLARE_R2_BACKUP_BUCKET');
  return missing;
}

let r2Client = null;
let r2Health = {
  checkedAt: null,
  ok: false,
  message: 'Not checked',
  latencyMs: null,
};
let schemaWarned = false;
let workerStarted = false;

function isMissingReplicationSchema(error) {
  const msg = String(error?.message || error || '');
  return (
    error?.code === 'PGRST204' ||
    error?.code === '42P01' ||
    /schema cache|media_storage_replicas|storage_replication_logs|Could not find the table/i.test(msg)
  );
}

async function safeStorageMonitoringQuery(query, fallback, label = 'storage monitoring query') {
  try {
    const result = await query;
    if (result?.error) throw result.error;
    return result || fallback;
  } catch (error) {
    if (isMissingReplicationSchema(error)) {
      if (!schemaWarned) {
        console.warn('[storage-redundancy] Storage replication schema is not available; returning empty monitoring data.');
        schemaWarned = true;
      }
      return fallback;
    }
    console.warn(`[storage-redundancy] ${label} failed:`, error?.message || error);
    return fallback;
  }
}

export function isR2MediaStorageConfigured() {
  return getMissingR2MediaEnvVars().length === 0;
}

export function getR2MediaStorageStatus() {
  const env = readR2MediaEnv();
  const missing = getMissingR2MediaEnvVars();
  return {
    configured: missing.length === 0,
    missing,
    endpointConfigured: Boolean(env.endpoint),
    bucketConfigured: Boolean(env.bucket),
    accessKeyConfigured: Boolean(env.accessKeyId),
    secretKeyConfigured: Boolean(env.secretAccessKey),
    publicBaseUrlConfigured: Boolean(env.publicBaseUrl),
    endpointHost: env.endpoint ? new URL(env.endpoint).hostname : null,
    bucket: env.bucket || null,
    region: env.region,
    health: r2Health,
  };
}

function getR2MediaClient() {
  const missing = getMissingR2MediaEnvVars();
  if (missing.length) throw new Error(`Cloudflare R2 media backup is not configured. Missing: ${missing.join(', ')}`);
  const env = readR2MediaEnv();
  if (!r2Client) {
    r2Client = new S3Client({
      region: env.region,
      endpoint: env.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    });
  }
  return r2Client;
}

export async function validateR2MediaBucket() {
  const env = readR2MediaEnv();
  const startedAt = Date.now();
  try {
    await getR2MediaClient().send(new HeadBucketCommand({ Bucket: env.bucket }));
    r2Health = {
      checkedAt: new Date().toISOString(),
      ok: true,
      message: 'Healthy',
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    r2Health = {
      checkedAt: new Date().toISOString(),
      ok: false,
      message: err?.message || String(err),
      latencyMs: Date.now() - startedAt,
    };
    throw err;
  }
  return { ...r2Health, bucket: env.bucket };
}

function encodeKey(key) {
  return String(key || '').split('/').map(encodeURIComponent).join('/');
}

function backupUrlForKey(key) {
  const env = readR2MediaEnv();
  if (!env.publicBaseUrl || !key) return null;
  return `${env.publicBaseUrl}/${encodeKey(key)}`;
}

function backendMediaUrlForKey(key) {
  if (!key) return null;
  const apiBase = resolvePublicApiUrl().replace(/\/+$/, '');
  const encodedKey = Buffer.from(String(key), 'utf8').toString('base64url');
  return `${apiBase}/api/videos/media/r2/${encodedKey}`;
}

function cleanMetadata(metadata = {}) {
  return Object.fromEntries(
    Object.entries(metadata || {})
      .filter(([, value]) => value != null && value !== '')
      .map(([name, value]) => [String(name).toLowerCase(), String(value).slice(0, 2048)]),
  );
}

export function getR2MediaPublicUrl(key) {
  return backupUrlForKey(key);
}

export function getR2MediaDeliveryUrl(key) {
  return backupUrlForKey(key) || backendMediaUrlForKey(key);
}

export function canUseR2MediaDirectUploads() {
  return isR2MediaStorageConfigured();
}

export async function createR2MediaSignedUploadUrl({ key, contentType, metadata = {}, expiresIn = 15 * 60 }) {
  if (!key) throw new Error('R2 upload key is required');
  if (!canUseR2MediaDirectUploads()) {
    const status = getR2MediaStorageStatus();
    throw new Error(`Cloudflare R2 media direct upload is not configured. Missing credentials: ${status.missing.join(', ') || 'unknown R2 setting'}`);
  }
  const env = readR2MediaEnv();
  const command = new PutObjectCommand({
    Bucket: env.bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
    Metadata: cleanMetadata(metadata),
  });
  return {
    provider: 'cloudflare_r2',
    bucket: env.bucket,
    key,
    publicUrl: getR2MediaDeliveryUrl(key),
    uploadUrl: await getSignedUrl(getR2MediaClient(), command, { expiresIn }),
    expiresIn,
  };
}

export async function getR2MediaObject({ key, range }) {
  if (!key) throw new Error('R2 media key is required');
  const env = readR2MediaEnv();
  const cleanRange = /^bytes=\d*-\d*$/i.test(String(range || '')) ? String(range) : undefined;
  const result = await getR2MediaClient().send(new GetObjectCommand({
    Bucket: env.bucket,
    Key: key,
    ...(cleanRange ? { Range: cleanRange } : {}),
  }));
  return {
    body: result.Body,
    contentType: result.ContentType || 'application/octet-stream',
    contentLength: result.ContentLength,
    contentRange: result.ContentRange || '',
    etag: result.ETag || '',
    lastModified: result.LastModified || null,
  };
}

function replicaIdentity(payload) {
  return {
    source_table: payload.sourceTable || null,
    source_id: payload.sourceId ? String(payload.sourceId) : null,
    media_type: payload.mediaType || 'asset',
    primary_bucket: payload.primaryBucket || null,
    primary_path: payload.primaryPath || null,
  };
}

async function logReplication(replicaId, action, status, message, metadata = {}) {
  if (!isSupabaseConfigured() || !supabase) return;
  try {
    const { error } = await supabase.from('storage_replication_logs').insert({
      replica_id: replicaId || null,
      action,
      status,
      message: message || null,
      metadata,
      created_at: new Date().toISOString(),
    });
    if (error && isMissingReplicationSchema(error) && !schemaWarned) {
      schemaWarned = true;
      console.warn('[storage-redundancy] Migration missing for storage_replication_logs.');
    }
  } catch (_) {}
}

async function findReplica(identity) {
  if (!isSupabaseConfigured() || !supabase) return null;
  let query = supabase
    .from('media_storage_replicas')
    .select('*')
    .eq('media_type', identity.media_type);

  if (identity.source_table) query = query.eq('source_table', identity.source_table);
  else query = query.is('source_table', null);
  if (identity.source_id) query = query.eq('source_id', identity.source_id);
  else query = query.is('source_id', null);
  if (identity.primary_bucket) query = query.eq('primary_bucket', identity.primary_bucket);
  else query = query.is('primary_bucket', null);
  if (identity.primary_path) query = query.eq('primary_path', identity.primary_path);
  else query = query.is('primary_path', null);

  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error && isMissingReplicationSchema(error)) return null;
  if (error) throw error;
  return data || null;
}

async function upsertReplica(payload, patch = {}) {
  if (!isSupabaseConfigured() || !supabase) return null;
  const identity = replicaIdentity(payload);
  const now = new Date().toISOString();
  const { incrementAttempts = 0, ...storedPatch } = patch;
  const base = {
    ...identity,
    primary_url: payload.primaryUrl || null,
    backup_bucket: payload.backupBucket || readR2MediaEnv().bucket || null,
    backup_key: payload.backupKey || null,
    backup_url: payload.backupUrl || null,
    storage_provider: 'supabase+r2',
    updated_at: now,
    ...storedPatch,
  };

  try {
    const existing = await findReplica(identity);
    if (existing?.id) {
      const { data, error } = await supabase
        .from('media_storage_replicas')
        .update({
          ...base,
          attempts: Number(existing.attempts || 0) + Number(incrementAttempts || 0),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw error;
      return data || { ...existing, ...base };
    }
    const { data, error } = await supabase
      .from('media_storage_replicas')
      .insert({
        id: crypto.randomUUID(),
        ...base,
        attempts: Number(incrementAttempts || 0),
        created_at: now,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data || null;
  } catch (err) {
    if (isMissingReplicationSchema(err)) {
      if (!schemaWarned) {
        schemaWarned = true;
        console.warn('[storage-redundancy] Migration missing for media_storage_replicas.');
      }
      return null;
    }
    throw err;
  }
}

async function updateSourceMediaColumns(payload, backupUrl, status) {
  if (!isSupabaseConfigured() || !supabase || !payload.sourceTable || !payload.sourceId) return;
  const patch = {
    primary_url: payload.primaryUrl || null,
    backup_url: backupUrl || null,
    storage_provider: 'supabase+r2',
    replication_status: status,
    last_sync_at: status === 'completed' ? new Date().toISOString() : null,
  };

  try {
    if (payload.sourceTable === 'tiktok_videos') {
      await supabase.from('tiktok_videos').update(patch).eq('video_id', payload.sourceId);
    } else if (payload.sourceTable === 'media') {
      await supabase.from('media').update(patch).eq('id', payload.sourceId);
    }
  } catch (_) {}
}

async function streamWithHash(inputStream) {
  const hash = crypto.createHash('sha256');
  const pass = new PassThrough();
  const done = pipeline(inputStream, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, pass).then(() => hash.digest('hex'));
  return { stream: pass, hashDone: done };
}

export async function replicateStorageObjectToR2(payload) {
  const backupKey = payload.backupKey || `${payload.primaryBucket}/${String(payload.primaryPath || '').replace(/^\/+/, '')}`;
  const backupUrl = backupUrlForKey(backupKey);
  const backupBucket = readR2MediaEnv().bucket || null;
  const basePayload = { ...payload, backupKey, backupUrl, backupBucket };
  let replica = null;

  try {
    replica = await upsertReplica(basePayload, {
      replication_status: isR2MediaStorageConfigured() ? 'replicating' : 'not_configured',
      integrity_status: 'pending',
      last_error: null,
      incrementAttempts: 1,
    });

    if (!isR2MediaStorageConfigured()) {
      const status = getR2MediaStorageStatus();
      await logReplication(replica?.id, 'replicate', 'not_configured', 'R2 media backup is not configured.', status);
      await updateSourceMediaColumns(payload, backupUrl, 'not_configured');
      return { ok: false, status: 'not_configured', missing: status.missing };
    }
    if (!payload.primaryBucket || !payload.primaryPath) {
      throw new Error('primaryBucket and primaryPath are required for R2 replication');
    }

    const object = await downloadFileFromBucketStream(payload.primaryBucket, payload.primaryPath);
    const { stream, hashDone } = await streamWithHash(object.stream);
    const contentType = payload.contentType || object.contentType || 'application/octet-stream';
    const contentLength = object.contentLength || null;

    await getR2MediaClient().send(new PutObjectCommand({
      Bucket: backupBucket,
      Key: backupKey,
      Body: stream,
      ContentType: contentType,
      Metadata: {
        primary_bucket: payload.primaryBucket,
        media_type: payload.mediaType || 'asset',
        source_table: payload.sourceTable || '',
        source_id: payload.sourceId ? String(payload.sourceId) : '',
      },
    }));
    const checksum = await hashDone.catch(() => null);

    const head = await getR2MediaClient().send(new HeadObjectCommand({ Bucket: backupBucket, Key: backupKey }));
    const r2Length = Number(head.ContentLength || 0) || null;
    const integrityOk = !contentLength || !r2Length || contentLength === r2Length;
    const completed = await upsertReplica(basePayload, {
      replication_status: integrityOk ? 'completed' : 'failed',
      integrity_status: integrityOk ? 'verified' : 'mismatch',
      content_type: contentType,
      content_length: contentLength || r2Length,
      checksum_sha256: checksum,
      last_error: integrityOk ? null : `Content length mismatch: primary=${contentLength}, backup=${r2Length}`,
      last_sync_at: integrityOk ? new Date().toISOString() : null,
    });

    await updateSourceMediaColumns(payload, backupUrl, integrityOk ? 'completed' : 'failed');
    await logReplication(
      completed?.id || replica?.id,
      'replicate',
      integrityOk ? 'completed' : 'failed',
      integrityOk ? 'Media replicated to Cloudflare R2.' : 'R2 integrity verification failed.',
      { backupKey, contentLength, r2Length, checksum }
    );

    return {
      ok: integrityOk,
      status: integrityOk ? 'completed' : 'failed',
      backupUrl,
      backupKey,
      checksum,
    };
  } catch (err) {
    const message = err?.message || String(err);
    const failed = await upsertReplica(basePayload, {
      replication_status: 'failed',
      integrity_status: 'failed',
      last_error: message,
    }).catch(() => replica);
    await updateSourceMediaColumns(payload, backupUrl, 'failed');
    await logReplication(failed?.id || replica?.id, 'replicate', 'failed', message, { backupKey }).catch(() => null);
    return { ok: false, status: 'failed', error: message };
  }
}

export function scheduleMediaReplication(payload) {
  const task = () => replicateStorageObjectToR2(payload).catch((err) => {
    console.warn('[storage-redundancy] Replication failed:', err?.message || err);
  });
  if (typeof setImmediate === 'function') setImmediate(task);
  else setTimeout(task, 0);
}

export function resolveMediaDeliveryUrl({ primaryUrl, backupUrl }) {
  const primary = primaryUrl || '';
  const backup = backupUrl || '';
  if (!primary) return backup;
  if (backup && (!isSupabaseConfigured() || !isSupabaseAvailable())) return backup;
  return primary;
}

export async function getStorageMonitoringOverview() {
  const primary = getSupabaseStatus();
  let r2 = getR2MediaStorageStatus();
  if (r2.configured) {
    try {
      await validateR2MediaBucket();
      r2 = getR2MediaStorageStatus();
    } catch (_) {
      r2 = getR2MediaStorageStatus();
    }
  }

  const overview = {
    totalVideos: 0,
    totalImages: 0,
    totalMedia: 0,
    primaryHealth: primary,
    r2Health: r2,
    replicationQueue: 0,
    failedReplications: 0,
    completedReplications: 0,
    backupCompletionPercentage: 0,
    storageUsageBytes: 0,
    recentLogs: [],
  };

  if (!isSupabaseConfigured() || !supabase) return overview;

  const [videos, images, replicas, failed, completed, usage, logs] = await Promise.all([
    safeStorageMonitoringQuery(
      supabase.from('tiktok_videos').select('video_id', { count: 'exact', head: true }),
      { count: 0 },
      'video count query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('media_storage_replicas').select('id', { count: 'exact', head: true }).eq('media_type', 'image'),
      { count: 0 },
      'image replica count query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('media_storage_replicas').select('id', { count: 'exact', head: true }).in('replication_status', ['pending', 'replicating']),
      { count: 0 },
      'replication queue count query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('media_storage_replicas').select('id', { count: 'exact', head: true }).eq('replication_status', 'failed'),
      { count: 0 },
      'failed replication count query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('media_storage_replicas').select('id', { count: 'exact', head: true }).eq('replication_status', 'completed'),
      { count: 0 },
      'completed replication count query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('media_storage_replicas').select('content_length').eq('replication_status', 'completed').limit(10000),
      { data: [] },
      'storage usage query',
    ),
    safeStorageMonitoringQuery(
      supabase.from('storage_replication_logs').select('*').order('created_at', { ascending: false }).limit(50),
      { data: [] },
      'replication logs query',
    ),
  ]);

  const totalVideos = Number(videos?.count || 0);
  const totalImages = Number(images?.count || 0);
  const queue = Number(replicas?.count || 0);
  const failedCount = Number(failed?.count || 0);
  const completedCount = Number(completed?.count || 0);
  const knownReplicas = queue + failedCount + completedCount;

  return {
    ...overview,
    totalVideos,
    totalImages,
    totalMedia: totalVideos + totalImages,
    replicationQueue: queue,
    failedReplications: failedCount,
    completedReplications: completedCount,
    backupCompletionPercentage: knownReplicas ? Math.round((completedCount / knownReplicas) * 10000) / 100 : 0,
    storageUsageBytes: (usage?.data || []).reduce((sum, row) => sum + (Number(row.content_length) || 0), 0),
    recentLogs: logs?.data || [],
  };
}

export async function retryFailedReplications(limit = 25) {
  if (!isSupabaseConfigured() || !supabase) return { queued: 0 };
  const { data, error } = await supabase
    .from('media_storage_replicas')
    .select('*')
    .eq('replication_status', 'failed')
    .order('updated_at', { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 100));
  if (error) {
    if (isMissingReplicationSchema(error)) return { queued: 0 };
    throw error;
  }
  for (const row of data || []) {
    scheduleMediaReplication({
      sourceTable: row.source_table,
      sourceId: row.source_id,
      mediaType: row.media_type,
      primaryBucket: row.primary_bucket,
      primaryPath: row.primary_path,
      primaryUrl: row.primary_url,
      backupKey: row.backup_key,
      contentType: row.content_type,
    });
  }
  return { queued: (data || []).length };
}

export async function forceBackupMedia({ limit = 50 } = {}) {
  if (!isSupabaseConfigured() || !supabase) return { queued: 0 };
  const { data, error } = await supabase
    .from('tiktok_videos')
    .select('video_id, storage_url, primary_url, backup_url')
    .is('backup_url', null)
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 250));
  if (error) throw error;

  let queued = 0;
  for (const row of data || []) {
    const primaryUrl = row.primary_url || row.storage_url;
    const parsed = parseSupabasePublicStoragePath(primaryUrl);
    if (!parsed) continue;
    scheduleMediaReplication({
      sourceTable: 'tiktok_videos',
      sourceId: row.video_id,
      mediaType: 'video',
      primaryBucket: parsed.bucket,
      primaryPath: parsed.path,
      primaryUrl,
    });
    queued += 1;
  }
  return { queued };
}

export async function listStorageReplicationLogs(limit = 100) {
  if (!isSupabaseConfigured() || !supabase) return [];
  const { data, error } = await supabase
    .from('storage_replication_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  if (error) {
    if (isMissingReplicationSchema(error)) return [];
    throw error;
  }
  return data || [];
}

export function parseSupabasePublicStoragePath(url) {
  if (!url || typeof url !== 'string' || !url.includes('/storage/v1/object/public/')) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], path: decodeURIComponent(m[2].replace(/\+/g, ' ')) };
  } catch {
    return null;
  }
}

export function startStorageReplicationWorker() {
  if (workerStarted) return;
  workerStarted = true;
  const intervalMs = Math.max(60000, Number(process.env.STORAGE_REPLICATION_WORKER_INTERVAL_MS || 300000));
  const run = () => {
    retryFailedReplications(Number(process.env.STORAGE_REPLICATION_WORKER_BATCH_SIZE || 10)).catch((err) => {
      if (!isMissingReplicationSchema(err)) {
        console.warn('[storage-redundancy] Worker retry failed:', err?.message || err);
      }
    });
  };
  setTimeout(run, 15000).unref?.();
  setInterval(run, intervalMs).unref?.();
}
