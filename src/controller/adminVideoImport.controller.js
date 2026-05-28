import {
  abortUploadSession,
  completeUploadSession,
  createUploadPartUrls,
  createUploadSession,
  deleteAllEnterpriseImports,
  deleteImportJob as deleteEnterpriseImportJob,
  getFailedRows,
  getImportAnalytics,
  getImportJob,
  getUploadSession,
  listUploadSessionParts,
  listImportJobs,
  registerExistingR2ImportObject,
  retryImportJob,
  updateImportJob,
} from '../services/enterpriseImport.service.js';
import {
  enqueueEnterpriseImportJob,
  getEnterpriseImportQueueHealth,
  reconcileEnterpriseImportQueue,
} from '../services/enterpriseImportQueue.service.js';
import { getEnterpriseImportWorkerRuntimeStatus } from '../services/enterpriseImportWorker.service.js';
import { appMemoryCache } from '../services/localMemoryCache.service.js';
import { subscribePlatformActivityEvents } from '../services/platformActivity.service.js';

function statusFromError(error, fallback = 500) {
  const status = Number(
    error?.statusCode ||
    error?.status ||
    error?.$metadata?.httpStatusCode ||
    error?.response?.statusCode ||
    error?.cause?.statusCode ||
    fallback,
  );
  return status >= 400 && status < 600 ? status : fallback;
}

function errorCode(error) {
  return error?.code || error?.Code || error?.name || error?.cause?.code || null;
}

function enterpriseImportErrorPayload(error, fallback) {
  const status = statusFromError(error);
  const code = errorCode(error);
  const rawMessage = String(error?.message || '').trim();
  const details = String(error?.details || error?.Detail || error?.cause?.message || '').trim();
  const hint = String(error?.hint || '').trim();
  const operation = String(error?.operation || '').trim();
  const requestId = error?.$metadata?.requestId || error?.$metadata?.extendedRequestId || null;
  const isGenericBadRequest = /^bad request$/i.test(rawMessage);
  const message = isGenericBadRequest
    ? [operation || fallback, code || rawMessage].filter(Boolean).join(': ')
    : (rawMessage || fallback);

  return {
    status,
    message,
    code,
    details,
    hint,
    operation,
    requestId,
  };
}

function progressPercent(job = {}) {
  const importProgress = job.metadata?.importProgress || {};
  const explicit = Number(importProgress.progressPercent);
  if (Number.isFinite(explicit) && explicit > 0 && job.status !== 'completed') {
    return Math.max(0, Math.min(99, Math.floor(explicit)));
  }
  const total = Number(job.total_rows || importProgress.rowsTotalActual || importProgress.rowsTotal || importProgress.rowsTotalEstimated || 0);
  const processed = Number(job.processed_rows || 0);
  if (total > 0) return Math.max(0, Math.min(100, Math.floor((processed / total) * 100)));
  return job.status === 'completed' ? 100 : 0;
}

function legacyJobShape(job = {}) {
  const importProgress = job.metadata?.importProgress || {};
  const uploadSession = job.upload_sessions || {};
  const originalFilename = uploadSession.original_filename || job.metadata?.originalFilename || job.metadata?.upload?.originalFilename || null;
  const r2Key = uploadSession.r2_key || job.metadata?.r2Key || job.metadata?.upload?.r2Key || null;
  const r2Bucket = uploadSession.r2_bucket || job.metadata?.r2Bucket || job.metadata?.upload?.r2Bucket || null;
  const contentType = uploadSession.content_type || job.metadata?.contentType || job.metadata?.upload?.contentType || null;
  const uploadBytes = Number(uploadSession.size_bytes || job.metadata?.sizeBytes || job.metadata?.upload?.originalBytes || 0);
  const rowsTotal = Number(job.total_rows || importProgress.rowsTotalActual || importProgress.rowsTotal || importProgress.rowsTotalEstimated || 0);
  const rowsProcessed = Number(job.processed_rows || importProgress.processedRows || importProgress.rowsProcessedEffective || 0);
  const rowsOk = Number(job.inserted_rows || 0) + Number(job.updated_rows || 0);
  const currentChunk = Number(importProgress.currentChunk || 0);
  const totalChunks = Number(importProgress.totalChunks || 0);
  return {
    ...job,
    import_type: 'csv',
    source_format: 'csv',
    import_status: job.status,
    progress_percent: progressPercent(job),
    rows_total: rowsTotal,
    rows_processed: rowsProcessed,
    rows_ok: rowsOk,
    rows_skipped: Number(job.duplicate_rows || 0),
    rows_failed: Number(job.failed_rows || 0),
    current_chunk: currentChunk,
    total_chunks: totalChunks,
    error_summary: job.error_message || null,
    catalog_filename: originalFilename,
    catalogFileName: originalFilename,
    r2_key: r2Key,
    r2Key,
    r2_bucket: r2Bucket,
    r2Bucket,
    metadata: {
      ...(job.metadata || {}),
      upload: {
        originalFilename,
        contentType,
        originalBytes: uploadBytes,
        storedBytes: uploadBytes,
        r2Key,
        r2Bucket,
        uploadSessionStatus: uploadSession.status || null,
        uploadedAt: uploadSession.completed_at || job.metadata?.uploadCompletedAt || null,
        storageMode: 'cloudflare_r2',
      },
      importProgress: {
        ...importProgress,
        rowsTotal,
        rowsTotalEstimated: Number(importProgress.rowsTotalEstimated || 0),
        processedRows: rowsProcessed,
        rowsProcessedEffective: rowsProcessed,
        importedRows: rowsOk,
        failedRows: Number(job.failed_rows || 0),
        remainingRows: Math.max(0, rowsTotal - rowsProcessed),
        importStatus: job.status,
        phase: job.status,
        currentChunk,
        totalChunks,
        rowsPerChunk: Number(importProgress.rowsPerChunk || 0),
        bytesProcessed: Number(job.bytes_processed || importProgress.bytesProcessed || 0),
        bytesTotal: Number(importProgress.bytesTotal || uploadBytes || 0),
        parserMode: importProgress.parserMode || null,
        chunkSpeedRowsPerSecond: Number(job.speed_rows_per_sec || 0),
        estimatedRemainingSeconds: Number(job.eta_seconds || 0),
      },
    },
  };
}

function sendError(res, error, fallback = 'Request failed') {
  const payload = enterpriseImportErrorPayload(error, fallback);
  const log = payload.status >= 500 ? console.error : console.warn;
  log('[enterprise-import]', {
    status: payload.status,
    message: payload.message,
    code: payload.code,
    details: payload.details || undefined,
    hint: payload.hint || undefined,
    operation: payload.operation || fallback,
    requestId: payload.requestId || undefined,
    stack: payload.status >= 500 ? error?.stack : undefined,
  });

  return res.status(payload.status).json({
    success: false,
    message: payload.message,
    ...(payload.code ? { code: payload.code } : {}),
    ...(payload.details && payload.details !== payload.message ? { details: payload.details } : {}),
    ...(payload.hint ? { hint: payload.hint } : {}),
  });
}

export async function createUploadSessionHandler(req, res) {
  try {
    const session = await createUploadSession({
      adminId: req.admin?.id || req.admin?.email,
      filename: req.body?.filename,
      sizeBytes: req.body?.sizeBytes,
      contentType: req.body?.contentType,
      sha256: req.body?.sha256,
    });
    return res.json({
      success: true,
      session,
      upload: {
        sessionId: session.id,
        uploadId: session.r2_upload_id,
        r2Key: session.r2_key,
        partSizeBytes: session.part_size_bytes,
        expiresAt: session.expires_at,
        maxParallelParts: Number(session.metadata?.maxParallelParts || 4),
      },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to create upload session');
  }
}

export async function getUploadSessionHandler(req, res) {
  try {
    const session = await getUploadSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Upload session not found' });
    return res.json({ success: true, session });
  } catch (error) {
    return sendError(res, error, 'Failed to load upload session');
  }
}

export async function createUploadPartUrlsHandler(req, res) {
  try {
    const result = await createUploadPartUrls({
      sessionId: req.params.sessionId,
      admin: req.admin,
      partNumbers: req.body?.partNumbers,
    });
    return res.json({
      success: true,
      sessionId: result.session.id,
      parts: result.parts,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    return sendError(res, error, 'Failed to create upload part URLs');
  }
}

export async function listUploadSessionPartsHandler(req, res) {
  try {
    const result = await listUploadSessionParts({
      sessionId: req.params.sessionId,
      admin: req.admin,
    });
    return res.json({
      success: true,
      sessionId: result.session.id,
      parts: result.parts,
    });
  } catch (error) {
    return sendError(res, error, 'Failed to list uploaded parts');
  }
}

export async function completeUploadSessionHandler(req, res) {
  try {
    const result = await completeUploadSession({
      sessionId: req.params.sessionId,
      admin: req.admin,
      parts: req.body?.parts,
    });
    return res.json({
      success: true,
      session: result.session,
      job: legacyJobShape(result.job),
      importJobId: result.job.id,
      status: result.job.status,
      queued: false,
    });
  } catch (error) {
    return sendError(res, error, 'Failed to complete upload session');
  }
}

export async function registerExistingR2ObjectHandler(req, res) {
  try {
    const result = await registerExistingR2ImportObject({
      admin: req.admin,
      r2Key: req.body?.r2Key || req.body?.r2_key || req.body?.key,
      filename: req.body?.filename || req.body?.originalFilename || null,
    });
    return res.json({
      success: true,
      session: result.session,
      job: legacyJobShape(result.job),
      importJobId: result.job.id,
      status: result.job.status,
      queued: false,
      createdSession: result.createdSession,
      r2: {
        key: result.session.r2_key,
        bucket: result.session.r2_bucket,
        contentType: result.head?.contentType || result.session.content_type,
        sizeBytes: Number(result.head?.contentLength || result.session.size_bytes || 0),
        etag: result.head?.etag || null,
        lastModified: result.head?.lastModified || null,
      },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to register Cloudflare R2 import file');
  }
}

export async function abortUploadSessionHandler(req, res) {
  try {
    const session = await abortUploadSession({
      sessionId: req.params.sessionId,
      admin: req.admin,
      reason: req.body?.reason || 'Upload aborted',
    });
    return res.json({ success: true, session });
  } catch (error) {
    return sendError(res, error, 'Failed to abort upload session');
  }
}

export async function listJobs(req, res) {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = req.query.status || null;
    const jobs = await listImportJobs({ limit, offset, status });
    return res.json({ success: true, data: jobs.map(legacyJobShape) });
  } catch (error) {
    return sendError(res, error, 'Failed to list import jobs');
  }
}

export async function getJob(req, res) {
  try {
    const job = await getImportJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Import job not found' });
    const errors = await getFailedRows(job.id, { limit: 20 });
    return res.json({ success: true, job: legacyJobShape(job), errors });
  } catch (error) {
    return sendError(res, error, 'Failed to load import job');
  }
}

export async function getJobErrors(req, res) {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const data = await getFailedRows(req.params.jobId, { limit, offset });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, 'Failed to load failed rows');
  }
}

export async function retryJob(req, res) {
  try {
    const job = await retryImportJob(req.params.jobId);
    return res.json({ success: true, job: legacyJobShape(job), queued: true });
  } catch (error) {
    return sendError(res, error, 'Retry failed');
  }
}

export async function startJob(req, res) {
  try {
    const job = await getImportJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Import job not found' });
    if (['uploaded', 'pending', 'queued'].includes(String(job.status || ''))) {
      const queued = job.status === 'queued'
        ? job
        : await updateImportJob(job.id, {
            status: 'queued',
            error_message: null,
            metadata: {
              ...(job.metadata || {}),
              manuallyStartedAt: new Date().toISOString(),
              manuallyStartedBy: req.admin?.id || req.admin?.email || null,
            },
          });
      await enqueueEnterpriseImportJob(queued.id, {
        reason: 'manual-start',
        source: 'admin-start',
        metadata: {
          uploadSessionId: queued.upload_session_id || job.upload_session_id || null,
          previousStatus: job.status,
        },
      });
      return res.json({ success: true, job: legacyJobShape(queued), queued: true });
    }
    return retryJob(req, res);
  } catch (error) {
    return sendError(res, error, 'Start failed');
  }
}

export async function rollbackJob(req, res) {
  return res.status(410).json({
    success: false,
    message: 'Rollback is not supported for canonical videos imports. Delete imported rows with a targeted admin operation instead.',
  });
}

export async function deleteJob(req, res) {
  try {
    await deleteEnterpriseImportJob(req.params.jobId);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Delete failed');
  }
}

export async function deleteAllImports(req, res) {
  try {
    const result = await deleteAllEnterpriseImports({ admin: req.admin });
    appMemoryCache.delete('enterprise-import:analytics');
    appMemoryCache.delete('enterprise-import:queue-health:cached');
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Delete all imports failed');
  }
}

export async function getAnalytics(req, res) {
  try {
    const analytics = await appMemoryCache.wrap('enterprise-import:analytics', () => getImportAnalytics(), 30_000);
    return res.json({ success: true, analytics });
  } catch (error) {
    return sendError(res, error, 'Failed to load import analytics');
  }
}

export async function getQueueHealth(req, res) {
  try {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    if (refresh) appMemoryCache.delete('enterprise-import:queue-health:cached');
    const health = refresh
      ? await getEnterpriseImportQueueHealth({ refresh: true })
      : await appMemoryCache.wrap('enterprise-import:queue-health:cached', () => getEnterpriseImportQueueHealth(), 15_000);
    return res.status(health.redis.configured && !health.redis.connected ? 503 : 200).json({
      success: true,
      health,
      worker: getEnterpriseImportWorkerRuntimeStatus(),
    });
  } catch (error) {
    return sendError(res, error, 'Failed to load queue health');
  }
}

export async function reconcileQueue(req, res) {
  try {
    const result = await reconcileEnterpriseImportQueue({ source: 'admin-reconcile' });
    const health = await getEnterpriseImportQueueHealth();
    return res.json({ success: true, result, health });
  } catch (error) {
    return sendError(res, error, 'Queue reconcile failed');
  }
}

export function importEventsStream(req, res) {
  return subscribePlatformActivityEvents(req, res);
}

export function uploadImportFile(_req, res) {
  return res.status(410).json({
    success: false,
    message: 'Direct backend uploads have been replaced by R2 multipart upload sessions.',
  });
}
