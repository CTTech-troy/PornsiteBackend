import { randomUUID, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { supabase } from '../config/supabase.js';
import {
  cleanupImportJobFiles,
  getJobWorkDir,
  getLocalSourcePath,
  resolveJobSourcePath,
  statJobSourceFile,
} from './videoImportArchive.service.js';
import { qstashClient } from '../config/qstash.js';
import { upstashRedis } from '../config/redis.js';
import { emitPlatformActivity, writePlatformActivityEvent } from './platformActivity.service.js';
import { getNumberSetting } from './platformSettings.service.js';

const REDIS_CURSOR_PREFIX = 'import:cursor:';
const DEFAULT_IMPORT_BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);
const MIN_IMPORT_BATCH_SIZE = 100;
const MAX_IMPORT_BATCH_SIZE = 10000;
const IMPORT_SCHEMA_CACHE_MS = 30000;
let importSchemaStatus = { checkedAt: 0, ok: false, message: null };

function isMissingTable(err) {
  return err?.code === '42P01' || err?.code === 'PGRST200' || /schema cache/i.test(String(err?.message || ''));
}

function isMissingColumn(err) {
  return err?.code === 'PGRST204' || err?.code === '42703' || /schema cache|Could not find|column/i.test(String(err?.message || ''));
}

function missingColumnName(err) {
  const msg = String(err?.message || '');
  return msg.match(/'([^']+)'/)?.[1] || msg.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i)?.[1] || null;
}

function importSchemaErrorMessage(details) {
  return [
    'Video import database schema is not ready.',
    details,
    'Run `npm run migrate:video-import` from the backend folder, or apply `backend/supabase/migrations/20260618120000_video_import_streaming_chunks.sql` in Supabase SQL Editor.',
  ].filter(Boolean).join(' ');
}

async function probeImportTable(table, select) {
  const { error } = await supabase.from(table).select(select).limit(1);
  if (!error) return null;
  return `${table}: ${error.message || error.code || 'schema check failed'}`;
}

export async function checkImportSchemaReady({ refresh = false } = {}) {
  if (!supabase) {
    return { ok: false, message: 'Database unavailable' };
  }
  const now = Date.now();
  if (!refresh && importSchemaStatus.checkedAt && now - importSchemaStatus.checkedAt < IMPORT_SCHEMA_CACHE_MS) {
    return importSchemaStatus;
  }

  const checks = [
    await probeImportTable(
      'video_import_jobs',
      'id,status,metadata,rows_total,rows_processed,rows_ok,rows_failed,progress_percent,staging_path',
    ),
    await probeImportTable(
      'video_import_batches',
      'id,job_id,batch_no,status,chunk_path,row_start,row_end,rows_total,rows_ok,rows_failed,attempts,error_summary,queued_at,started_at,completed_at,updated_at',
    ),
    await probeImportTable(
      'video_import_errors',
      'id,job_id,row_number,raw_row,error_code,message,created_at',
    ),
  ].filter(Boolean);

  importSchemaStatus = {
    checkedAt: now,
    ok: checks.length === 0,
    message: checks.join('; '),
  };
  return importSchemaStatus;
}

export async function assertImportSchemaReady() {
  const status = await checkImportSchemaReady();
  if (status.ok) return;
  const err = new Error(importSchemaErrorMessage(status.message));
  err.statusCode = 500;
  err.code = 'VIDEO_IMPORT_SCHEMA_MISSING';
  throw err;
}

function getImportWorkflowUrl(path) {
  const base = String(process.env.BACKEND_PUBLIC_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/internal/qstash/video-import${path}`;
}

export async function createImportJob({
  adminId,
  importType = 'full',
  sourceFormat = 'csv',
  metadata = {},
}) {
  if (!supabase) throw new Error('Database unavailable');
  await assertImportSchemaReady();
  const id = randomUUID();
  const workDir = getJobWorkDir(id);
  const stagingPath = getLocalSourcePath(workDir, sourceFormat);
  const mergedMetadata = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    workDir,
    localSourcePath: stagingPath,
    storageMode: 'local_disk',
  };

  const { data, error } = await supabase.from('video_import_jobs').insert({
    id,
    admin_id: adminId || null,
    import_type: importType,
    source_format: sourceFormat,
    status: 'pending',
    staging_path: stagingPath,
    metadata: mergedMetadata,
  }).select('*').single();

  if (error) throw error;
  return data;
}

export async function getImportJob(jobId) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('video_import_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listImportJobs({ limit = 50, offset = 0, status = null } = {}) {
  if (!supabase) return [];
  let q = supabase.from('video_import_jobs').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

export async function updateImportJob(jobId, patch) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('video_import_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

function mergeMetadata(current = {}, patch = {}) {
  const next = {
    ...(current && typeof current === 'object' ? current : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  if (current?.importProgress || patch?.importProgress) {
    next.importProgress = {
      ...(current?.importProgress && typeof current.importProgress === 'object' ? current.importProgress : {}),
      ...(patch?.importProgress && typeof patch.importProgress === 'object' ? patch.importProgress : {}),
    };
  }
  if (current?.upload || patch?.upload) {
    next.upload = {
      ...(current?.upload && typeof current.upload === 'object' ? current.upload : {}),
      ...(patch?.upload && typeof patch.upload === 'object' ? patch.upload : {}),
    };
  }
  return next;
}

export function emitImportProgress(job) {
  if (!job?.id) return;
  const importProgress = job.metadata?.importProgress || {};
  const rowsProcessed = Number(importProgress.rowsProcessedEffective ?? importProgress.processedRows ?? job.rows_processed ?? 0);
  const rowsTotal = Number(job.rows_total || importProgress.rowsTotal || 0);
  const rowsFailed = Number(job.rows_failed || importProgress.failedRows || 0);
  const progressPercent = rowsTotal > 0
    ? Math.max(0, Math.min(100, Math.floor((rowsProcessed / rowsTotal) * 100)))
    : Number(job.progress_percent || 0);
  emitPlatformActivity(null, 'import_progress', {
    title: 'Video import progress',
    message: rowsTotal > 0
      ? `Import ${job.id}: ${rowsProcessed.toLocaleString()} / ${rowsTotal.toLocaleString()} videos imported`
      : `Import ${job.id} is ${Math.round(progressPercent)}% complete`,
    targetType: 'video_import_job',
    targetId: job.id,
    payload: {
      jobId: job.id,
      status: job.status,
      importStatus: importProgress.importStatus || job.import_status || job.status,
      progressPercent,
      rowsTotal,
      rowsProcessed,
      rowsOk: Number(job.rows_ok || 0),
      rowsSkipped: Number(job.rows_skipped || 0),
      rowsFailed,
      rowsRemaining: rowsTotal > 0 ? Math.max(0, rowsTotal - rowsProcessed) : 0,
      currentChunk: Number(importProgress.currentChunk || job.current_chunk || 0),
      totalChunks: Number(importProgress.totalChunks || job.total_chunks || 0),
      rowsPerChunk: Number(importProgress.rowsPerChunk || 0),
      chunkSpeedRowsPerSecond: Number(importProgress.chunkSpeedRowsPerSecond || 0),
      estimatedRemainingSeconds: Number(importProgress.estimatedRemainingSeconds || 0),
      phase: importProgress.phase || null,
      importProgress: {
        ...importProgress,
        rowsTotal,
        processedRows: rowsProcessed,
        rowsProcessedEffective: rowsProcessed,
        importedRows: Number(job.rows_ok || 0),
        failedRows: rowsFailed,
        remainingRows: rowsTotal > 0 ? Math.max(0, rowsTotal - rowsProcessed) : 0,
        importStatus: importProgress.importStatus || job.import_status || job.status,
      },
    },
  });
}

export async function updateImportJobWithMetadata(jobId, metadataPatch = {}, patch = {}) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');
  const importProgress = metadataPatch?.importProgress || {};
  const progressPatch = {
    ...(importProgress.totalChunks != null ? { total_chunks: Number(importProgress.totalChunks) } : {}),
    ...(importProgress.currentChunk != null ? { current_chunk: Number(importProgress.currentChunk) } : {}),
    ...(importProgress.importStatus ? { import_status: String(importProgress.importStatus) } : {}),
    ...(importProgress.rowsTotal != null ? { rows_total: Number(importProgress.rowsTotal) } : {}),
    ...(importProgress.processedRows != null ? { rows_processed: Number(importProgress.processedRows) } : {}),
    ...(importProgress.rowsProcessedEffective != null ? { rows_processed: Number(importProgress.rowsProcessedEffective) } : {}),
    ...(importProgress.failedRows != null ? { rows_failed: Number(importProgress.failedRows) } : {}),
  };
  const updated = await updateImportJob(jobId, {
    ...progressPatch,
    ...patch,
    metadata: mergeMetadata(job.metadata || {}, metadataPatch || {}),
  });
  emitImportProgress(updated);
  return updated;
}

export async function createStagingUploadUrl() {
  throw new Error('Direct storage uploads are disabled for video imports. Use POST /api/admin/content/imports/upload.');
}

export async function downloadStagingFile(stagingPath, destPath) {
  const sourcePath = path.isAbsolute(stagingPath) ? stagingPath : resolveJobSourcePath({ staging_path: stagingPath });
  await pipeline(fs.createReadStream(sourcePath), fs.createWriteStream(destPath));
  return destPath;
}

export async function openStagingFileStream(stagingPathOrJob) {
  const job = typeof stagingPathOrJob === 'object' && stagingPathOrJob !== null
    ? stagingPathOrJob
    : { staging_path: stagingPathOrJob };
  const { sourcePath, size } = await statJobSourceFile(job);
  return {
    stream: fs.createReadStream(sourcePath),
    contentLength: size,
    localPath: sourcePath,
  };
}

export function normalizeImportBatchSize(value) {
  const n = Math.round(Number(value) || DEFAULT_IMPORT_BATCH_SIZE);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMPORT_BATCH_SIZE;
  return Math.max(MIN_IMPORT_BATCH_SIZE, Math.min(MAX_IMPORT_BATCH_SIZE, n));
}

export async function getConfiguredImportBatchSize(override = null) {
  if (override != null && override !== '') return normalizeImportBatchSize(override);
  const configured = await getNumberSetting('import_batch_size', DEFAULT_IMPORT_BATCH_SIZE).catch(() => DEFAULT_IMPORT_BATCH_SIZE);
  return normalizeImportBatchSize(configured);
}

export async function setImportCursor(jobId, offset) {
  if (upstashRedis) {
    await upstashRedis.set(`${REDIS_CURSOR_PREFIX}${jobId}`, String(offset));
  }
  if (supabase) {
    const { error } = await supabase.from('video_import_batches').insert({
      job_id: jobId,
      batch_no: Math.floor(offset / 500),
      cursor_offset: offset,
    });
    if (error && !isMissingTable(error)) {
      console.warn('[video-import] cursor checkpoint failed:', error.message || error);
    }
  }
}

export async function getImportCursor(jobId) {
  if (upstashRedis) {
    const val = await upstashRedis.get(`${REDIS_CURSOR_PREFIX}${jobId}`);
    if (val != null) return Number(val) || 0;
  }
  if (!supabase) return 0;
  const { data } = await supabase
    .from('video_import_batches')
    .select('cursor_offset')
    .eq('job_id', jobId)
    .order('cursor_offset', { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.cursor_offset) || 0;
}

export async function logImportError(jobId, rowNumber, rawRow, errorCode, message) {
  if (!supabase) return;
  await supabase.from('video_import_errors').insert({
    job_id: jobId,
    row_number: rowNumber,
    raw_row: sanitizeImportErrorRow(rawRow || {}),
    error_code: errorCode,
    message: String(message || '').slice(0, 2000),
  });
}

function sanitizeImportErrorValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeImportErrorValue);
  if (value && typeof value === 'object') {
    return sanitizeImportErrorRow(value);
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<iframe\b[^>]*\/?>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function sanitizeImportErrorRow(rawRow = {}) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) return {};
  const out = {};
  for (const [key, value] of Object.entries(rawRow)) {
    if (/raw(line|_line|csv|_csv)?$/i.test(key)) continue;
    const cleaned = sanitizeImportErrorValue(value);
    if (cleaned !== '' && cleaned != null) out[key] = cleaned;
  }
  return out;
}

function normalizeBatchPayload(batch) {
  return {
    job_id: batch.job_id || batch.jobId,
    batch_no: Number(batch.batch_no ?? batch.batchNo ?? 0),
    rows_total: Number(batch.rows_total ?? batch.rowsTotal ?? 0),
    rows_ok: Number(batch.rows_ok ?? batch.rowsOk ?? 0),
    rows_skipped: Number(batch.rows_skipped ?? batch.rowsSkipped ?? 0),
    rows_failed: Number(batch.rows_failed ?? batch.rowsFailed ?? 0),
    cursor_offset: Number(batch.cursor_offset ?? batch.cursorOffset ?? 0),
    status: batch.status || 'pending',
    chunk_path: batch.chunk_path || batch.chunkPath || null,
    row_start: batch.row_start ?? batch.rowStart ?? null,
    row_end: batch.row_end ?? batch.rowEnd ?? null,
    attempts: Number(batch.attempts || 0),
    error_summary: batch.error_summary ?? batch.errorSummary ?? null,
    queued_at: batch.queued_at ?? batch.queuedAt ?? null,
    started_at: batch.started_at ?? batch.startedAt ?? null,
    completed_at: batch.completed_at ?? batch.completedAt ?? null,
    updated_at: new Date().toISOString(),
  };
}

async function writeBatchPayload(payload) {
  const { data: existingRows, error: lookupError } = await supabase
    .from('video_import_batches')
    .select('id')
    .eq('job_id', payload.job_id)
    .eq('batch_no', payload.batch_no)
    .limit(1);
  if (lookupError && !isMissingTable(lookupError)) throw lookupError;

  const existingId = existingRows?.[0]?.id;
  if (existingId) {
    return supabase
      .from('video_import_batches')
      .update(payload)
      .eq('id', existingId)
      .select('*')
      .maybeSingle();
  }
  return supabase
    .from('video_import_batches')
    .insert(payload)
    .select('*')
    .maybeSingle();
}

export async function saveImportBatch(batch) {
  if (!supabase) return null;
  const payload = normalizeBatchPayload(batch);
  let body = { ...payload };
  let lastError = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { data, error } = await writeBatchPayload(body);
    if (!error) return data || body;
    lastError = error;
    if (!isMissingColumn(error)) break;
    const col = missingColumnName(error);
    if (!col || !(col in body)) break;
    delete body[col];
  }
  if (lastError && !isMissingTable(lastError)) {
    console.warn('[video-import] batch checkpoint failed:', lastError.message || lastError);
  }
  return null;
}

export async function getImportBatch(jobId, batchNo) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('video_import_batches')
    .select('*')
    .eq('job_id', jobId)
    .eq('batch_no', Number(batchNo))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return data;
}

export async function listImportBatches(jobId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('video_import_batches')
    .select('*')
    .eq('job_id', jobId)
    .order('batch_no', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return data || [];
}

export async function getNextRunnableImportBatch(jobId, { failedOnly = false } = {}) {
  const batches = await listImportBatches(jobId);
  const candidates = batches.filter((batch) => {
    const status = String(batch.status || 'pending');
    if (failedOnly) return status === 'failed';
    return !['completed', 'skipped'].includes(status);
  });
  return candidates[0] || null;
}

export async function enqueueImportStep(jobId, step, body = {}) {
  const url = getImportWorkflowUrl(`/${step}`);
  if (!qstashClient || !url) {
    return { queued: false, reason: 'QStash not configured' };
  }
  const result = await qstashClient.publishJSON({
    url,
    body: { jobId, ...body },
    retries: 3,
    headers: { 'Content-Type': 'application/json', 'X-Workflow-Source': 'video-import' },
  });
  return { queued: true, ...result };
}

export async function startImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');
  if (!['pending', 'uploaded', 'failed', 'paused', 'counting', 'queued'].includes(job.status)) {
    throw new Error(`Cannot start job in status: ${job.status}`);
  }
  await updateImportJob(jobId, { status: 'queued', started_at: job.started_at || new Date().toISOString() });
  const failedBatch = job.status === 'failed' ? await getNextRunnableImportBatch(jobId, { failedOnly: true }) : null;
  if (failedBatch) {
    return enqueueImportStep(jobId, 'process-chunk', { batchNo: failedBatch.batch_no, retryFailed: true });
  }
  const progress = job.metadata?.importProgress || {};
  const rowsTotal = Number(job.rows_total || progress.rowsTotal || 0);
  const pendingBatch = await getNextRunnableImportBatch(jobId);
  if (pendingBatch && progress.extractionComplete) {
    return enqueueImportStep(jobId, 'process-chunk', { batchNo: pendingBatch.batch_no });
  }
  if (rowsTotal > 0 && progress.extractionComplete === false && pendingBatch) {
    return enqueueImportStep(jobId, 'process-chunk', { batchNo: pendingBatch.batch_no });
  }
  if (rowsTotal > 0 && (progress.countComplete || progress.phase === 'counted')) {
    return enqueueImportStep(jobId, 'extract');
  }
  if (rowsTotal > 0 && !progress.countComplete) {
    return enqueueImportStep(jobId, 'extract');
  }
  return enqueueImportStep(jobId, 'count');
}

export async function finalizeImportJob(jobId, { success = true, errorSummary = null, cleanupFiles = null } = {}) {
  const job = await getImportJob(jobId);
  await updateImportJob(jobId, {
    status: success ? 'completed' : 'failed',
    progress_percent: success ? 100 : job?.progress_percent || 0,
    completed_at: new Date().toISOString(),
    error_summary: errorSummary,
  });
  const shouldCleanup = cleanupFiles != null ? cleanupFiles : success;
  if (shouldCleanup && job) {
    await cleanupImportJobFiles(job).catch((err) => {
      console.warn('[video-import] temp cleanup failed:', err?.message || err);
    });
  }
  await writePlatformActivityEvent({
    eventType: success ? 'import_completed' : 'import_failed',
    title: success ? 'Video import completed' : 'Video import failed',
    message: success
      ? `Import ${jobId} finished: ${job?.rows_ok || 0} videos imported`
      : `Import ${jobId} failed: ${errorSummary || 'Unknown error'}`,
    targetType: 'video_import_job',
    targetId: jobId,
    payload: { rowsOk: job?.rows_ok, rowsFailed: job?.rows_failed },
  });
}

export function computeImportHash(row) {
  const key = String(
    row.stream_url ||
    row.streamUrl ||
    row.embed_url ||
    row.embedUrl ||
    row.metadata?.importSource?.url ||
    row.external_id ||
    row.externalId ||
    row.title ||
    '',
  ).trim().toLowerCase();
  return createHash('sha256').update(key).digest('hex').slice(0, 64);
}

export async function getImportAnalytics() {
  if (!supabase) return { totalJobs: 0, completed: 0, failed: 0, rowsImported: 0 };
  const { data: jobs } = await supabase.from('video_import_jobs').select('status, rows_ok, rows_failed, created_at').order('created_at', { ascending: false }).limit(500);
  const list = jobs || [];
  return {
    totalJobs: list.length,
    completed: list.filter((j) => j.status === 'completed').length,
    failed: list.filter((j) => j.status === 'failed').length,
    rowsImported: list.reduce((s, j) => s + Number(j.rows_ok || 0), 0),
    recent: list.slice(0, 10),
  };
}
