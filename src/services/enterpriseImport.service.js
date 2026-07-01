import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { supabase } from '../config/supabase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import { emitPlatformActivity, writePlatformActivityEvent } from './platformActivity.service.js';
import { enqueueEnterpriseImportJob } from './enterpriseImportQueue.service.js';
import {
  abortR2MultipartUpload,
  completeR2MultipartUpload,
  createR2MultipartUpload,
  createR2UploadPartUrl,
  deleteR2Object,
  headR2Object,
  listR2MultipartUploadParts,
  R2_IMPORT_BUCKET,
  R2_UPLOAD_PART_URL_TTL_SECONDS,
} from './r2ImportStorage.service.js';

export const IMPORT_UPLOAD_PART_SIZE_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.IMPORT_R2_PART_SIZE_BYTES || 64 * 1024 * 1024),
);
export const IMPORT_UPLOAD_MAX_PARALLEL_PARTS = Math.max(
  1,
  Math.min(8, Number(process.env.IMPORT_UPLOAD_MAX_PARALLEL_PARTS || 4)),
);
export const IMPORT_UPLOAD_SESSION_TTL_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.IMPORT_UPLOAD_SESSION_TTL_MS || 6 * 60 * 60 * 1000),
);
export const IMPORT_MAX_CSV_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.IMPORT_MAX_CSV_BYTES || 10 * 1024 * 1024 * 1024),
);

const ALLOWED_CSV_MIME = new Set([
  '',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'text/plain',
]);

export const importUploadSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ADMIN_IMPORT_UPLOAD_SESSION_MAX_PER_MIN || 30),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('admin:import-upload-session', { redis: false }),
  message: {
    success: false,
    message: 'Too many import upload requests. Please slow down.',
  },
});

function ensureSupabase() {
  if (!supabase) throw new Error('Database unavailable');
}

const ENTERPRISE_IMPORT_SCHEMA_CHECKS = [
  {
    table: 'upload_sessions',
    select: 'id,status,original_filename,r2_key,r2_upload_id,expires_at',
  },
  {
    table: 'import_jobs',
    select: 'id,upload_session_id,status,total_rows,processed_rows,checkpoint_row_number',
  },
  {
    table: 'failed_rows',
    select: 'id,import_job_id,row_number,error_code',
  },
  {
    table: 'videos',
    select: 'id,video_url,title,video_fingerprint,import_job_id',
  },
];

function isMissingEnterpriseImportTable(error) {
  return error?.code === '42P01' ||
    error?.code === 'PGRST200' ||
    /schema cache|Could not find the table|does not exist/i.test(String(error?.message || ''));
}

function isMissingEnterpriseImportColumn(error) {
  const message = String(`${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`);
  return error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    /schema cache|column .* does not exist|Could not find .* column|Could not find the .* column/i.test(message);
}

function enterpriseErrorStatus(error, fallback = 500) {
  const status = Number(
    error?.statusCode ||
    error?.status ||
    error?.$metadata?.httpStatusCode ||
    error?.response?.statusCode ||
    fallback,
  );
  return status >= 400 && status < 600 ? status : fallback;
}

function enterpriseErrorCode(error, fallback = null) {
  return error?.code || error?.Code || error?.name || error?.cause?.code || fallback;
}

function decorateEnterpriseError(error, operation, fallbackStatus = 500) {
  const statusCode = enterpriseErrorStatus(error, fallbackStatus);
  const code = enterpriseErrorCode(error);
  const rawMessage = String(error?.message || error || '').trim();
  const details = String(error?.details || error?.Detail || error?.cause?.message || '').trim();
  const isGenericBadRequest = /^bad request$/i.test(rawMessage);
  const message = isGenericBadRequest
    ? `${operation}: ${code || rawMessage}`
    : (operation ? `${operation}: ${rawMessage || 'failed'}` : (rawMessage || 'Request failed'));
  const wrapped = new Error(message);
  wrapped.statusCode = statusCode;
  wrapped.code = code || error?.code;
  wrapped.details = details || error?.details;
  wrapped.hint = error?.hint;
  wrapped.operation = operation;
  wrapped.cause = error;
  if (error?.$metadata) wrapped.$metadata = error.$metadata;
  return wrapped;
}

export async function checkEnterpriseImportSchemaReady() {
  ensureSupabase();
  const missing = [];
  for (const check of ENTERPRISE_IMPORT_SCHEMA_CHECKS) {
    const { error } = await supabase.from(check.table).select(check.select).limit(1);
    if (error && isMissingEnterpriseImportTable(error)) {
      missing.push(check.table);
    } else if (error) {
      throw error;
    }
  }
  return {
    ok: missing.length === 0,
    missing,
  };
}

export async function assertEnterpriseImportSchemaReady() {
  const status = await checkEnterpriseImportSchemaReady();
  if (status.ok) return status;
  const err = new Error(
    `Enterprise import database schema is not ready. Missing tables: ${status.missing.join(', ')}. Run npm run migrate:video-import after setting DATABASE_URL or SUPABASE_DB_PASSWORD.`,
  );
  err.statusCode = 503;
  err.code = 'ENTERPRISE_IMPORT_SCHEMA_MISSING';
  throw err;
}

export function assertImportPermission(admin) {
  const role = String(admin?.role || '').toLowerCase();
  const permissions = Array.isArray(admin?.permissions) ? admin.permissions : [];
  const allowed = admin?.is_super_admin ||
    ['admin', 'operations'].includes(role) ||
    permissions.includes('content_imports') ||
    permissions.includes('/content/imports') ||
    permissions.includes('content');
  if (!allowed) {
    const err = new Error('Content import access required');
    err.statusCode = 403;
    throw err;
  }
}

export function requireImportPermission(req, res, next) {
  try {
    assertImportPermission(req.admin);
    return next();
  } catch (err) {
    return res.status(err.statusCode || 403).json({ success: false, message: err.message });
  }
}

function safeFilename(filename) {
  const raw = String(filename || 'import.csv').trim();
  const base = raw.split(/[\\/]/).pop() || 'import.csv';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 180) || 'import.csv';
}

function normalizeExistingR2ImportKey(value) {
  const key = String(value || '').trim().replace(/^\/+/, '');
  if (!key) {
    const err = new Error('Cloudflare R2 key is required');
    err.statusCode = 400;
    throw err;
  }
  if (key.includes('..') || /[\r\n]/.test(key)) {
    const err = new Error('Cloudflare R2 key is invalid');
    err.statusCode = 400;
    throw err;
  }
  if (!key.toLowerCase().endsWith('.csv')) {
    const err = new Error('Only existing .csv import objects can be registered');
    err.statusCode = 400;
    throw err;
  }
  return key;
}

function validateUploadMetadata({ filename, sizeBytes, contentType }) {
  const cleanName = safeFilename(filename);
  if (!cleanName.toLowerCase().endsWith('.csv')) {
    const err = new Error('Only .csv files are allowed');
    err.statusCode = 400;
    throw err;
  }
  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    const err = new Error('CSV file size is required');
    err.statusCode = 400;
    throw err;
  }
  if (size > IMPORT_MAX_CSV_BYTES) {
    const err = new Error(`CSV file exceeds the ${Math.round(IMPORT_MAX_CSV_BYTES / 1024 / 1024)} MB import limit`);
    err.statusCode = 413;
    throw err;
  }
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CSV_MIME.has(type)) {
    const err = new Error('CSV content type is not allowed');
    err.statusCode = 400;
    throw err;
  }
  return {
    filename: cleanName,
    sizeBytes: Math.round(size),
    contentType: type || 'text/csv',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sessionExpiresAt() {
  return new Date(Date.now() + IMPORT_UPLOAD_SESSION_TTL_MS).toISOString();
}

function mergeMetadata(current = {}, patch = {}) {
  return {
    ...(current && typeof current === 'object' ? current : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
}

function uploadSessionJobMetadata(session = {}, patch = {}) {
  return mergeMetadata({
    r2Bucket: session.r2_bucket || R2_IMPORT_BUCKET || null,
    r2Key: session.r2_key || null,
    originalFilename: session.original_filename || null,
    contentType: session.content_type || 'text/csv',
    sizeBytes: Number(session.size_bytes || 0),
    uploadCompletedAt: session.completed_at || session.metadata?.uploadCompletedAt || null,
    storageMode: 'cloudflare_r2',
    catalogVisible: true,
  }, patch);
}

async function createImportJobForUploadedSession(session, metadataPatch = {}, options = {}) {
  if (!session?.id || String(session.status || '') !== 'uploaded') return null;

  const { data: existingJobs, error: existingError } = await supabase
    .from('import_jobs')
    .select('*')
    .eq('upload_session_id', session.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (existingError) throw existingError;
  const reusableJob = (existingJobs || []).find((job) => {
    if (!options.createNewIfTerminal) return true;
    return !['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase());
  });
  if (reusableJob) return reusableJob;

  const { data: job, error } = await supabase.from('import_jobs').insert({
    upload_session_id: session.id,
    admin_id: session.admin_id,
    status: 'uploaded',
    metadata: uploadSessionJobMetadata(session, metadataPatch),
  }).select('*').single();
  if (error) throw error;

  return job;
}

function jobProgress(job = {}) {
  const importProgress = job.metadata?.importProgress || {};
  const explicit = Number(importProgress.progressPercent);
  if (Number.isFinite(explicit) && explicit > 0 && job.status !== 'completed') {
    return Math.max(0, Math.min(99, Math.floor(explicit)));
  }
  const totalRows = Number(job.total_rows || importProgress.rowsTotalActual || importProgress.rowsTotal || importProgress.rowsTotalEstimated || 0);
  const processedRows = Number(job.processed_rows || 0);
  return totalRows > 0 ? Math.max(0, Math.min(100, Math.floor((processedRows / totalRows) * 100))) : 0;
}

export function emitEnterpriseImportProgress(job) {
  if (!job?.id) return;
  const importProgress = job.metadata?.importProgress || {};
  const totalRows = Number(job.total_rows || importProgress.rowsTotalActual || importProgress.rowsTotal || importProgress.rowsTotalEstimated || 0);
  const processedRows = Number(job.processed_rows || 0);
  const failedRows = Number(job.failed_rows || 0);
  const currentChunk = Number(importProgress.currentChunk || 0);
  const totalChunks = Number(importProgress.totalChunks || 0);
  emitPlatformActivity(null, 'enterprise_import_progress', {
    title: 'CSV import progress',
    message: totalRows > 0
      ? `Import ${job.id}: ${processedRows.toLocaleString()} / ${totalRows.toLocaleString()} rows processed`
      : `Import ${job.id} is ${String(job.status || 'queued')}`,
    targetType: 'import_job',
    targetId: job.id,
    payload: {
      jobId: job.id,
      uploadSessionId: job.upload_session_id,
      status: job.status,
      progressPercent: jobProgress(job),
      rowsTotal: totalRows,
      rowsProcessed: processedRows,
      rowsOk: Number(job.inserted_rows || 0) + Number(job.updated_rows || 0),
      rowsFailed: failedRows,
      rowsRemaining: totalRows > 0 ? Math.max(0, totalRows - processedRows) : 0,
      insertedRows: Number(job.inserted_rows || 0),
      updatedRows: Number(job.updated_rows || 0),
      duplicateRows: Number(job.duplicate_rows || 0),
      currentSpeed: Number(job.speed_rows_per_sec || 0),
      estimatedRemainingSeconds: Number(job.eta_seconds || 0),
      checkpointRowNumber: Number(job.checkpoint_row_number || 0),
      currentChunk,
      totalChunks,
      rowsPerChunk: Number(importProgress.rowsPerChunk || 0),
      bytesProcessed: Number(job.bytes_processed || importProgress.bytesProcessed || 0),
      bytesTotal: Number(importProgress.bytesTotal || job.metadata?.sizeBytes || 0),
      parserMode: importProgress.parserMode || null,
      phase: job.status,
      importStatus: job.status,
      importProgress: {
        ...importProgress,
        rowsTotal: totalRows,
        processedRows,
        rowsProcessedEffective: processedRows,
        importedRows: Number(job.inserted_rows || 0) + Number(job.updated_rows || 0),
        failedRows,
        remainingRows: totalRows > 0 ? Math.max(0, totalRows - processedRows) : 0,
        importStatus: job.status,
        chunkSpeedRowsPerSecond: Number(job.speed_rows_per_sec || 0),
        estimatedRemainingSeconds: Number(job.eta_seconds || 0),
        currentChunk,
        totalChunks,
        phase: job.status,
      },
    },
  });
}

export async function createUploadSession({ adminId, filename, sizeBytes, contentType, sha256 = null }) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  const upload = validateUploadMetadata({ filename, sizeBytes, contentType });
  const id = randomUUID();
  const expiresAt = sessionExpiresAt();
  const r2Key = `imports/tmp/${id}/${upload.filename}`;

  let created = null;
  try {
    created = await createR2MultipartUpload({
      key: r2Key,
      contentType: upload.contentType,
      metadata: {
        upload_session_id: id,
        original_filename: upload.filename,
      },
    });

    const { data, error } = await supabase.from('upload_sessions').insert({
      id,
      admin_id: adminId || null,
      status: 'pending',
      original_filename: upload.filename,
      content_type: upload.contentType,
      size_bytes: upload.sizeBytes,
      sha256: sha256 || null,
      r2_bucket: created.bucket,
      r2_key: created.key,
      r2_upload_id: created.uploadId,
      part_size_bytes: IMPORT_UPLOAD_PART_SIZE_BYTES,
      expires_at: expiresAt,
      metadata: {
        maxParallelParts: IMPORT_UPLOAD_MAX_PARALLEL_PARTS,
      },
    }).select('*').single();

    if (error) throw error;
    return data;
  } catch (err) {
    if (created?.uploadId) {
      await abortR2MultipartUpload({ key: r2Key, uploadId: created.uploadId }).catch(() => {});
    }
    throw err;
  }
}

export async function registerExistingR2ImportObject({ admin, r2Key, filename = null } = {}) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  const key = normalizeExistingR2ImportKey(r2Key);
  let head = null;
  try {
    head = await headR2Object(key);
  } catch (error) {
    throw decorateEnterpriseError(error, 'Cloudflare R2 object lookup failed', 404);
  }

  const sizeBytes = Number(head?.contentLength || 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    const err = new Error('Cloudflare R2 object is empty');
    err.statusCode = 400;
    throw err;
  }
  const contentType = String(head?.contentType || 'text/csv').split(';')[0].trim().toLowerCase() || 'text/csv';
  if (!ALLOWED_CSV_MIME.has(contentType) && contentType !== 'binary/octet-stream') {
    const err = new Error(`Cloudflare R2 object content type is not allowed: ${contentType}`);
    err.statusCode = 400;
    throw err;
  }

  const originalFilename = safeFilename(filename || key.split('/').pop() || 'import.csv');
  let createdSession = false;
  let session = null;
  const { data: existingSession, error: existingError } = await supabase
    .from('upload_sessions')
    .select('*')
    .eq('r2_key', key)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existingSession) {
    if (['processing'].includes(String(existingSession.status || ''))) {
      const err = new Error('This Cloudflare R2 catalog is already attached to a running import');
      err.statusCode = 409;
      throw err;
    }
    session = await updateUploadSession(existingSession.id, {
      status: 'uploaded',
      error_message: null,
      original_filename: existingSession.original_filename || originalFilename,
      content_type: contentType,
      size_bytes: sizeBytes,
      r2_bucket: existingSession.r2_bucket || R2_IMPORT_BUCKET,
      r2_key: key,
      r2_upload_id: existingSession.r2_upload_id || null,
      completed_at: existingSession.completed_at || nowIso(),
      metadata: mergeMetadata(existingSession.metadata, {
        r2Head: head,
        registeredExistingR2Object: true,
        registeredExistingR2ObjectAt: nowIso(),
      }),
    });
  } else {
    const { data, error } = await supabase.from('upload_sessions').insert({
      id: randomUUID(),
      admin_id: admin?.id || admin?.email || null,
      status: 'uploaded',
      original_filename: originalFilename,
      content_type: contentType,
      size_bytes: sizeBytes,
      sha256: null,
      r2_bucket: R2_IMPORT_BUCKET,
      r2_key: key,
      r2_upload_id: null,
      part_size_bytes: IMPORT_UPLOAD_PART_SIZE_BYTES,
      multipart_parts: [],
      completed_at: nowIso(),
      expires_at: new Date(Date.now() + IMPORT_UPLOAD_SESSION_TTL_MS).toISOString(),
      metadata: {
        r2Head: head,
        registeredExistingR2Object: true,
        registeredExistingR2ObjectAt: nowIso(),
        storageMode: 'cloudflare_r2',
      },
    }).select('*').single();
    if (error) throw error;
    session = data;
    createdSession = true;
  }

  const job = await createImportJobForUploadedSession(session, {
    registeredExistingR2Object: true,
    registeredExistingR2ObjectAt: nowIso(),
    r2Head: head,
  }, {
    createNewIfTerminal: true,
  });
  emitEnterpriseImportProgress(job);
  await writePlatformActivityEvent({
    eventType: 'enterprise_import_uploaded',
    title: 'CSV import registered',
    message: `Registered existing Cloudflare R2 catalog ${originalFilename}.`,
    targetType: 'import_job',
    targetId: job.id,
    actorId: admin?.id || admin?.email || session.admin_id,
    payload: { jobId: job.id, uploadSessionId: session.id, status: 'uploaded', importStatus: 'uploaded', r2Key: key },
  }).catch(() => {});

  return {
    session,
    job,
    head,
    createdSession,
  };
}

export async function getUploadSession(sessionId) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  const { data, error } = await supabase.from('upload_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function updateUploadSession(sessionId, patch) {
  ensureSupabase();
  const { data, error } = await supabase
    .from('upload_sessions')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', sessionId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

function assertSessionOwnedByAdmin(session, admin) {
  if (!session) {
    const err = new Error('Upload session not found');
    err.statusCode = 404;
    throw err;
  }
  if (admin?.is_super_admin) return;
  if (session.admin_id && admin?.id && String(session.admin_id) !== String(admin.id)) {
    const err = new Error('Upload session access denied');
    err.statusCode = 403;
    throw err;
  }
}

function assertSessionOpen(session) {
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    const err = new Error('Upload session has expired');
    err.statusCode = 410;
    throw err;
  }
  if (!['pending', 'uploading'].includes(String(session.status))) {
    const err = new Error(`Cannot upload parts while session is ${session.status}`);
    err.statusCode = 409;
    throw err;
  }
}

export async function createUploadPartUrls({ sessionId, admin, partNumbers }) {
  const session = await getUploadSession(sessionId);
  assertSessionOwnedByAdmin(session, admin);
  assertSessionOpen(session);
  const numbers = Array.from(new Set((Array.isArray(partNumbers) ? partNumbers : []).map(Number)))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 10000)
    .sort((a, b) => a - b);

  if (!numbers.length) {
    const err = new Error('partNumbers must contain at least one valid part number');
    err.statusCode = 400;
    throw err;
  }
  if (numbers.length > 100) {
    const err = new Error('Request at most 100 part URLs at a time');
    err.statusCode = 400;
    throw err;
  }

  const expiresAt = new Date(Date.now() + R2_UPLOAD_PART_URL_TTL_SECONDS * 1000).toISOString();
  const parts = await Promise.all(numbers.map(async (partNumber) => ({
    partNumber,
    uploadUrl: await createR2UploadPartUrl({
      key: session.r2_key,
      uploadId: session.r2_upload_id,
      partNumber,
    }),
    expiresAt,
  })));

  if (session.status === 'pending') {
    await updateUploadSession(session.id, { status: 'uploading' });
  }

  return { session, parts, expiresAt };
}

export async function listUploadSessionParts({ sessionId, admin }) {
  const session = await getUploadSession(sessionId);
  assertSessionOwnedByAdmin(session, admin);
  assertSessionOpen(session);
  const parts = await listR2MultipartUploadParts({
    key: session.r2_key,
    uploadId: session.r2_upload_id,
  });
  return { session, parts };
}

function normalizeCompletedParts(parts) {
  const normalized = (Array.isArray(parts) ? parts : [])
    .map((part) => ({
      partNumber: Number(part.partNumber ?? part.PartNumber),
      etag: String(part.etag ?? part.ETag ?? '').trim(),
    }))
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber);
  if (!normalized.length) {
    const err = new Error('Uploaded part ETags are required');
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

function comparableEtag(value) {
  return String(value || '')
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"+|"+$/g, '')
    .toLowerCase();
}

function uploadPartCountForSession(session) {
  const size = Number(session?.size_bytes || 0);
  const partSize = Number(session?.part_size_bytes || IMPORT_UPLOAD_PART_SIZE_BYTES);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(partSize) || partSize <= 0) return null;
  return Math.max(1, Math.ceil(size / partSize));
}

async function reconcileCompletedPartsWithR2(session, completedParts) {
  let r2Parts = [];
  try {
    r2Parts = await listR2MultipartUploadParts({
      key: session.r2_key,
      uploadId: session.r2_upload_id,
    });
  } catch (error) {
    throw decorateEnterpriseError(error, 'R2 uploaded part validation failed', 502);
  }

  const expectedCount = uploadPartCountForSession(session);
  if (expectedCount && completedParts.length !== expectedCount) {
    const err = new Error(`Upload is incomplete: expected ${expectedCount} part(s), received ${completedParts.length}. Resume the upload before completing it.`);
    err.statusCode = 400;
    err.code = 'UPLOAD_PARTS_INCOMPLETE';
    err.operation = 'complete upload session';
    throw err;
  }

  if (!r2Parts.length) {
    const err = new Error('Cloudflare R2 has no uploaded parts for this session. Resume the upload before completing it.');
    err.statusCode = 400;
    err.code = 'R2_PARTS_MISSING';
    err.operation = 'complete upload session';
    throw err;
  }

  const r2ByPart = new Map(r2Parts.map((part) => [Number(part.partNumber), part]));
  const missing = [];
  const mismatched = [];
  const reconciled = completedParts.map((part) => {
    const r2Part = r2ByPart.get(part.partNumber);
    if (!r2Part) {
      missing.push(part.partNumber);
      return part;
    }
    if (comparableEtag(part.etag) !== comparableEtag(r2Part.etag)) {
      mismatched.push(part.partNumber);
    }
    return {
      ...part,
      etag: r2Part.etag || part.etag,
    };
  });

  if (missing.length || mismatched.length) {
    const err = new Error([
      missing.length ? `missing R2 part(s): ${missing.slice(0, 20).join(', ')}` : '',
      mismatched.length ? `ETag mismatch on part(s): ${mismatched.slice(0, 20).join(', ')}` : '',
    ].filter(Boolean).join('; '));
    err.statusCode = 400;
    err.code = 'R2_PARTS_DO_NOT_MATCH';
    err.operation = 'complete upload session';
    throw err;
  }

  return reconciled;
}

export async function completeUploadSession({ sessionId, admin, parts }) {
  ensureSupabase();
  const session = await getUploadSession(sessionId);
  assertSessionOwnedByAdmin(session, admin);
  assertSessionOpen(session);
  const completedParts = await reconcileCompletedPartsWithR2(session, normalizeCompletedParts(parts));

  try {
    await completeR2MultipartUpload({
      key: session.r2_key,
      uploadId: session.r2_upload_id,
      parts: completedParts,
    });
  } catch (error) {
    await updateUploadSession(session.id, {
      status: 'failed',
      error_message: decorateEnterpriseError(error, 'R2 multipart completion failed', 400).message,
    }).catch(() => {});
    throw decorateEnterpriseError(error, 'R2 multipart completion failed', 400);
  }

  const head = await headR2Object(session.r2_key);
  const expectedBytes = Number(session.size_bytes || 0);
  if (expectedBytes > 0 && Number(head.contentLength || 0) !== expectedBytes) {
    await updateUploadSession(session.id, {
      status: 'failed',
      error_message: `Uploaded object size mismatch: expected ${expectedBytes}, received ${head.contentLength}`,
    });
    const err = new Error('Uploaded object size mismatch');
    err.statusCode = 409;
    throw err;
  }

  const uploaded = await updateUploadSession(session.id, {
    status: 'uploaded',
    multipart_parts: completedParts,
    completed_at: nowIso(),
    metadata: mergeMetadata(session.metadata, {
      r2Head: head,
      uploadCompletedAt: nowIso(),
    }),
  });

  const job = await createImportJobForUploadedSession(uploaded, {
    uploadCompletedAt: nowIso(),
  });

  emitEnterpriseImportProgress(job);
  await writePlatformActivityEvent({
    eventType: 'enterprise_import_uploaded',
    title: 'CSV import uploaded',
    message: `Import ${job.id} is ready to start for ${session.original_filename}`,
    targetType: 'import_job',
    targetId: job.id,
    actorId: session.admin_id,
    payload: { jobId: job.id, uploadSessionId: session.id, status: 'uploaded', importStatus: 'uploaded' },
  }).catch(() => {});

  return { session: uploaded, job };
}

export async function abortUploadSession({ sessionId, admin, reason = 'Upload aborted' }) {
  const session = await getUploadSession(sessionId);
  assertSessionOwnedByAdmin(session, admin);
  if (session?.r2_upload_id && ['pending', 'uploading'].includes(String(session.status))) {
    await abortR2MultipartUpload({ key: session.r2_key, uploadId: session.r2_upload_id }).catch(() => {});
  }
  return updateUploadSession(session.id, {
    status: 'failed',
    error_message: reason,
  });
}

export async function reconcileUploadedImportSessions({ limit = 100 } = {}) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 100));
  const { data: sessions, error } = await supabase
    .from('upload_sessions')
    .select('id,admin_id,status,original_filename,content_type,size_bytes,r2_bucket,r2_key,completed_at,metadata,created_at,updated_at')
    .eq('status', 'uploaded')
    .order('created_at', { ascending: false })
    .limit(limitNum);
  if (error) throw error;

  const uploadedSessions = Array.isArray(sessions) ? sessions.filter((session) => session?.id && session?.r2_key) : [];
  if (!uploadedSessions.length) return { scanned: 0, recovered: 0, jobs: [] };

  const sessionIds = uploadedSessions.map((session) => session.id);
  const { data: existingJobs, error: jobError } = await supabase
    .from('import_jobs')
    .select('id,upload_session_id')
    .in('upload_session_id', sessionIds);
  if (jobError) throw jobError;

  const existingSessionIds = new Set((existingJobs || []).map((job) => job.upload_session_id).filter(Boolean));
  const recovered = [];
  for (const session of uploadedSessions) {
    if (existingSessionIds.has(session.id)) continue;
    const job = await createImportJobForUploadedSession(session, {
      recoveredFromUploadSession: true,
      recoveredFromUploadSessionAt: nowIso(),
      recoveryReason: 'uploaded-r2-catalog-file-was-missing-import-job',
    });
    if (job) {
      recovered.push(job);
      emitEnterpriseImportProgress(job);
      await writePlatformActivityEvent({
        eventType: 'enterprise_import_uploaded',
        title: 'CSV import recovered',
        message: `Recovered uploaded catalog ${session.original_filename} from Cloudflare R2.`,
        targetType: 'import_job',
        targetId: job.id,
        actorId: session.admin_id,
        payload: { jobId: job.id, uploadSessionId: session.id, status: 'uploaded', importStatus: 'uploaded', recovered: true },
      }).catch(() => {});
    }
  }

  return { scanned: uploadedSessions.length, recovered: recovered.length, jobs: recovered };
}

export async function getImportJob(jobId) {
  ensureSupabase();
  const { data, error } = await supabase
    .from('import_jobs')
    .select('*, upload_sessions(original_filename,size_bytes,status,r2_key,r2_bucket,content_type,completed_at)')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function listImportJobs({ limit = 50, offset = 0, status = null } = {}) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  if (!status || String(status) === 'uploaded') {
    await reconcileUploadedImportSessions({ limit: Math.max(limit, 100) }).catch((error) => {
      console.warn('[enterprise-import] uploaded R2 catalog reconciliation failed:', error?.message || error);
    });
  }
  let query = supabase
    .from('import_jobs')
    .select('*, upload_sessions(original_filename,size_bytes,status,r2_key,r2_bucket,content_type,completed_at)')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function updateImportJob(jobId, patch) {
  ensureSupabase();
  const { data, error } = await supabase
    .from('import_jobs')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', jobId)
    .select('*')
    .single();
  if (error) throw error;
  emitEnterpriseImportProgress(data);
  return data;
}

export async function retryImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) {
    const err = new Error('Import job not found');
    err.statusCode = 404;
    throw err;
  }
  if (!['failed', 'cancelled'].includes(String(job.status))) {
    const err = new Error(`Cannot retry job while it is ${job.status}`);
    err.statusCode = 409;
    throw err;
  }
  const queued = await updateImportJob(jobId, {
    status: 'queued',
    error_message: null,
    attempt_count: Number(job.attempt_count || 0) + 1,
  });
  await enqueueEnterpriseImportJob(jobId, {
    reason: 'manual-retry',
    source: 'retryImportJob',
    metadata: { previousStatus: job.status },
  }).catch(async (queueError) => {
    console.warn('[enterprise-import:queue] retry enqueue failed:', queueError?.message || queueError);
    await updateImportJob(jobId, {
      metadata: mergeMetadata(queued.metadata, {
        queueEnqueueFailedAt: nowIso(),
        queueEnqueueError: String(queueError?.message || queueError).slice(0, 500),
      }),
    }).catch(() => {});
  });
  return queued;
}

export async function getFailedRows(jobId, { limit = 100, offset = 0 } = {}) {
  ensureSupabase();
  const { data, error } = await supabase
    .from('failed_rows')
    .select('*')
    .eq('import_job_id', jobId)
    .order('row_number', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

export async function getImportAnalytics() {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  const { data, error } = await supabase
    .from('import_jobs')
    .select('status,total_rows,processed_rows,inserted_rows,updated_rows,failed_rows,created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const rows = data || [];
  return {
    totalJobs: rows.length,
    completed: rows.filter((job) => job.status === 'completed').length,
    failed: rows.filter((job) => job.status === 'failed').length,
    rowsImported: rows.reduce((sum, job) => sum + Number(job.inserted_rows || 0) + Number(job.updated_rows || 0), 0),
    rowsFailed: rows.reduce((sum, job) => sum + Number(job.failed_rows || 0), 0),
    recent: rows.slice(0, 10),
  };
}

export async function deleteImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) return false;
  if (['counting', 'processing'].includes(String(job.status))) {
    const err = new Error('Cannot delete a running import job');
    err.statusCode = 409;
    throw err;
  }
  const { error } = await supabase.from('import_jobs').delete().eq('id', jobId);
  if (error) throw error;
  return true;
}

export async function cleanupCompletedUploadObject(job) {
  const session = job?.upload_session_id ? await getUploadSession(job.upload_session_id).catch(() => null) : null;
  const r2Key = session?.r2_key || job?.metadata?.r2Key;
  if (r2Key) await deleteR2Object(r2Key).catch((err) => {
    console.warn('[enterprise-import] R2 cleanup failed:', err?.message || err);
  });
  if (session?.id) {
    await updateUploadSession(session.id, { status: 'completed' }).catch(() => {});
  }
}

export async function expireStaleUploadSessions() {
  ensureSupabase();
  const { data, error } = await supabase
    .from('upload_sessions')
    .select('*')
    .in('status', ['pending', 'uploading'])
    .lt('expires_at', nowIso())
    .limit(100);
  if (error) throw error;
  for (const session of data || []) {
    await abortR2MultipartUpload({ key: session.r2_key, uploadId: session.r2_upload_id }).catch(() => {});
    await updateUploadSession(session.id, { status: 'expired', error_message: 'Upload session expired' }).catch(() => {});
  }
  return (data || []).length;
}

function normalizeImportedVideoCategoryFilter(value) {
  return String(value || '')
    .trim()
    .replace(/^category:/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function importedVideoCategoryVariants(value) {
  const raw = String(value || '').replace(/^category:/i, '').trim();
  const normalized = normalizeImportedVideoCategoryFilter(raw);
  if (!normalized) return [];
  const spaced = normalized.replace(/_/g, ' ');
  const dashed = normalized.replace(/_/g, '-');
  const humanized = spaced
    .split(' ')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
    .join(' ');
  return [...new Set([raw, normalized, spaced, dashed, humanized].map((item) => String(item || '').trim()).filter(Boolean))];
}

export async function listImportedVideos({ page = 1, limit = 20, category = null } = {}) {
  ensureSupabase();
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const from = (pageNum - 1) * limitNum;
  const to = from + limitNum - 1;
  const variants = importedVideoCategoryVariants(category);
  let query = supabase
    .from('videos')
    .select('id,video_url,iframe_embed,playback_type,title,duration,thumbnail_url,tags,actors,views,category,quality,studio,publish_date,metadata,created_at,updated_at,import_jobs(status)')
    .order('created_at', { ascending: false });
  if (variants.length > 0) {
    query = query.or(variants.map((value) => `category.ilike.${value}`).join(','));
  }
  const { data, error } = await query.range(from, to);
  if (error) throw error;
  return data || [];
}

const IMPORTED_VIDEO_CATEGORY_CACHE_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.IMPORTED_VIDEO_CATEGORY_CACHE_TTL_MS || 5 * 60 * 1000),
);
let importedVideoCategoryCache = { ts: 0, rows: null };

function normalizeImportedCategoryValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function importedCategoryId(value) {
  return normalizeImportedCategoryValue(value).replace(/_/g, '-');
}

function importedCategoryLabel(value) {
  const raw = String(value || '').trim();
  const text = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const acronyms = new Set(['ai', 'asmr', 'bbw', 'milf']);
  return text
    .split(' ')
    .map((part) => {
      const lower = part.toLowerCase();
      return acronyms.has(lower) ? lower.toUpperCase() : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function mapImportedCategory(value, count = 0) {
  const normalized = normalizeImportedCategoryValue(value);
  if (!normalized) return null;
  return {
    id: importedCategoryId(normalized),
    value: normalized,
    label: importedCategoryLabel(value || normalized),
    count: Number(count || 0),
    source: 'imported',
  };
}

function uniqueImportedCategories(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = typeof row === 'string' ? row : row?.value || row?.category;
    const normalized = normalizeImportedCategoryValue(value);
    if (!normalized) continue;
    const nextCount = Number(row?.count ?? row?.video_count ?? 1) || 1;
    counts.set(normalized, (counts.get(normalized) || 0) + nextCount);
  }
  return [...counts.entries()]
    .map(([value, count]) => mapImportedCategory(value, count))
    .filter(Boolean)
    .sort((a, b) => (Number(b.count || 0) - Number(a.count || 0)) || a.label.localeCompare(b.label));
}

export async function listImportedVideoCategories({ limit = 200, force = false } = {}) {
  ensureSupabase();
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 200));
  const now = Date.now();
  if (
    !force &&
    Array.isArray(importedVideoCategoryCache.rows) &&
    now - importedVideoCategoryCache.ts < IMPORTED_VIDEO_CATEGORY_CACHE_TTL_MS
  ) {
    return importedVideoCategoryCache.rows.slice(0, limitNum).map((row) => ({ ...row }));
  }

  let rpcResult;
  try {
    rpcResult = await supabase.rpc('get_imported_video_categories', { p_limit: limitNum });
  } catch (error) {
    rpcResult = { data: null, error };
  }

  if (!rpcResult.error && Array.isArray(rpcResult.data)) {
    const rows = uniqueImportedCategories(
      rpcResult.data.map((row) => ({
        value: row.value || row.category,
        count: row.video_count || row.count || 0,
      })),
    ).slice(0, limitNum);
    importedVideoCategoryCache = { ts: now, rows };
    return rows.map((row) => ({ ...row }));
  }

  const sampled = [];
  const pageSize = 1000;
  const maxRows = Math.min(50000, Math.max(5000, Number(process.env.IMPORTED_VIDEO_CATEGORY_SCAN_MAX_ROWS || 20000)));
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await supabase
      .from('videos')
      .select('category')
      .not('category', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) break;
    sampled.push(...data);
    if (data.length < pageSize) break;
  }

  const rows = uniqueImportedCategories(sampled).slice(0, limitNum);
  importedVideoCategoryCache = { ts: now, rows };
  return rows.map((row) => ({ ...row }));
}

export async function getImportedVideo(videoId) {
  ensureSupabase();
  const { data, error } = await supabase
    .from('videos')
    .select('id,video_url,iframe_embed,playback_type,title,duration,thumbnail_url,tags,actors,views,category,quality,studio,publish_date,metadata,created_at,updated_at,import_jobs(status)')
    .eq('id', videoId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

const ENTERPRISE_IMPORT_DELETE_SELECT_BATCH_SIZE = Math.max(
  25,
  Math.min(500, Number(process.env.ENTERPRISE_IMPORT_DELETE_SELECT_BATCH_SIZE || 200) || 200),
);
const ENTERPRISE_IMPORT_DELETE_ID_CHUNK_SIZE = Math.max(
  10,
  Math.min(100, Number(process.env.ENTERPRISE_IMPORT_DELETE_ID_CHUNK_SIZE || 50) || 50),
);
const ENTERPRISE_IMPORT_DELETE_TIME_BUDGET_MS = Math.max(
  10_000,
  Math.min(110_000, Number(process.env.ENTERPRISE_IMPORT_DELETE_TIME_BUDGET_MS || 90_000) || 90_000),
);

function isStatementTimeout(error) {
  return error?.code === '57014' || /statement timeout|canceling statement/i.test(String(error?.message || error?.details || ''));
}

function deleteTimeRemaining(context) {
  return Date.now() - context.startedAt < context.maxRuntimeMs;
}

function uniqueDeleteIds(rows, idColumn) {
  return [...new Set((rows || []).map((row) => row?.[idColumn]).filter(Boolean))];
}

async function deleteIdChunk(table, idColumn, ids, label) {
  if (!ids.length) return;
  const { error } = await supabase
    .from(table)
    .delete()
    .in(idColumn, ids);

  if (!error) return;

  if (ids.length > 1 && isStatementTimeout(error)) {
    const midpoint = Math.ceil(ids.length / 2);
    await deleteIdChunk(table, idColumn, ids.slice(0, midpoint), label);
    await deleteIdChunk(table, idColumn, ids.slice(midpoint), label);
    return;
  }

  throw decorateEnterpriseError(error, `${label} delete failed`, enterpriseErrorStatus(error));
}

async function deleteSelectedIds(table, idColumn, ids, label) {
  for (let i = 0; i < ids.length; i += ENTERPRISE_IMPORT_DELETE_ID_CHUNK_SIZE) {
    await deleteIdChunk(table, idColumn, ids.slice(i, i + ENTERPRISE_IMPORT_DELETE_ID_CHUNK_SIZE), label);
  }
}

async function deleteRowsInBatches(
  label,
  table,
  {
    idColumn = 'id',
    buildSelect = (query) => query,
    context,
  } = {},
) {
  const deleteContext = context || {
    startedAt: Date.now(),
    maxRuntimeMs: ENTERPRISE_IMPORT_DELETE_TIME_BUDGET_MS,
  };
  const startedAt = Date.now();
  let deleted = 0;
  let batches = 0;
  let complete = false;

  while (deleteTimeRemaining(deleteContext)) {
    const { data, error } = await buildSelect(
      supabase
        .from(table)
        .select(idColumn)
        .limit(ENTERPRISE_IMPORT_DELETE_SELECT_BATCH_SIZE),
    );

    if (error) {
      throw decorateEnterpriseError(error, `${label} select failed`, enterpriseErrorStatus(error));
    }

    const ids = uniqueDeleteIds(data, idColumn);
    if (!ids.length) {
      complete = true;
      break;
    }

    await deleteSelectedIds(table, idColumn, ids, label);
    deleted += ids.length;
    batches += 1;

    console.log('[enterprise-import] Delete batch completed', {
      label,
      table,
      deleted,
      batchRows: ids.length,
      batches,
      durationMs: Date.now() - startedAt,
    });

    if (ids.length < ENTERPRISE_IMPORT_DELETE_SELECT_BATCH_SIZE) {
      complete = true;
      break;
    }
  }

  return { deleted, complete, batches, durationMs: Date.now() - startedAt };
}

async function deleteRowsInBatchesIfAvailable(label, table, options) {
  try {
    return { ...(await deleteRowsInBatches(label, table, options)), skipped: false };
  } catch (error) {
    if (isMissingEnterpriseImportColumn(error)) {
      console.warn(`[enterprise-import] Skipping delete selector "${label}" because the expected column is missing.`);
      return { deleted: 0, complete: true, skipped: true, error };
    }
    throw error;
  }
}

async function deleteImportedVideosInBatches(context) {
  let deleted = 0;
  let complete = true;

  const byImportJob = await deleteRowsInBatchesIfAvailable(
    'videos.import_job_id',
    'videos',
    {
      context,
      buildSelect: (query) => query.not('import_job_id', 'is', null),
    },
  );
  deleted += byImportJob.deleted;
  complete = complete && byImportJob.complete;
  if (!complete || !deleteTimeRemaining(context)) return { deleted, complete: false };

  const bySourceRow = await deleteRowsInBatchesIfAvailable(
    'videos.source_row_number',
    'videos',
    {
      context,
      buildSelect: (query) => query.not('source_row_number', 'is', null),
    },
  );
  deleted += bySourceRow.deleted;
  complete = complete && bySourceRow.complete;
  if (!complete || !deleteTimeRemaining(context)) return { deleted, complete: false };

  const externalWithoutCreator = await deleteRowsInBatchesIfAvailable(
    'videos.external_playback_without_creator',
    'videos',
    {
      context,
      buildSelect: (query) => query
        .in('playback_type', ['external_embed', 'external_redirect'])
        .is('creator_id', null),
    },
  );
  if (externalWithoutCreator.skipped) {
    const externalPlayback = await deleteRowsInBatchesIfAvailable(
      'videos.external_playback',
      'videos',
      {
        context,
        buildSelect: (query) => query.in('playback_type', ['external_embed', 'external_redirect']),
      },
    );
    deleted += externalPlayback.deleted;
    complete = complete && externalPlayback.complete;
  } else {
    deleted += externalWithoutCreator.deleted;
    complete = complete && externalWithoutCreator.complete;
  }
  if (!complete || !deleteTimeRemaining(context)) return { deleted, complete: false };

  const emptyWithoutCreator = await deleteRowsInBatchesIfAvailable(
    'videos.empty_legacy_import_rows',
    'videos',
    {
      context,
      buildSelect: (query) => query
        .is('creator_id', null)
        .is('video_url', null)
        .is('iframe_embed', null),
    },
  );
  if (emptyWithoutCreator.skipped) {
    const emptyRows = await deleteRowsInBatchesIfAvailable(
      'videos.empty_legacy_import_rows_without_creator_column',
      'videos',
      {
        context,
        buildSelect: (query) => query
          .is('video_url', null)
          .is('iframe_embed', null),
      },
    );
    deleted += emptyRows.deleted;
    complete = complete && emptyRows.complete;
  } else {
    deleted += emptyWithoutCreator.deleted;
    complete = complete && emptyWithoutCreator.complete;
  }

  return { deleted, complete };
}

export async function deleteAllEnterpriseImports({ admin = null } = {}) {
  ensureSupabase();
  await assertEnterpriseImportSchemaReady();
  if (admin) assertImportPermission(admin);

  const startedAt = Date.now();
  const context = {
    startedAt,
    maxRuntimeMs: ENTERPRISE_IMPORT_DELETE_TIME_BUDGET_MS,
  };
  const videoResult = await deleteImportedVideosInBatches(context);
  let failedRowsDeleted = 0;
  let importJobsDeleted = 0;
  let uploadSessionsDeleted = 0;
  let complete = videoResult.complete;

  if (complete && deleteTimeRemaining(context)) {
    const failedRows = await deleteRowsInBatches('failed_rows.all', 'failed_rows', { context });
    failedRowsDeleted = failedRows.deleted;
    complete = complete && failedRows.complete;
  }

  if (complete && deleteTimeRemaining(context)) {
    const importJobs = await deleteRowsInBatches('import_jobs.all', 'import_jobs', { context });
    importJobsDeleted = importJobs.deleted;
    complete = complete && importJobs.complete;
  }

  if (complete && deleteTimeRemaining(context)) {
    const uploadSessions = await deleteRowsInBatches('upload_sessions.all', 'upload_sessions', { context });
    uploadSessionsDeleted = uploadSessions.deleted;
    complete = complete && uploadSessions.complete;
  }

  if (complete) importedVideoCategoryCache = { ts: 0, rows: null };

  return {
    videosDeleted: videoResult.deleted,
    failedRowsDeleted,
    importJobsDeleted,
    uploadSessionsDeleted,
    complete,
    needsContinue: !complete,
    durationMs: Date.now() - startedAt,
  };
}
