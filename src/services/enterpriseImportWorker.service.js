import { setTimeout as sleep } from 'timers/promises';
import { Readable, Transform } from 'stream';
import { supabase } from '../config/supabase.js';
import {
  cleanupCompletedUploadObject,
  emitEnterpriseImportProgress,
  getImportJob,
  getUploadSession,
  updateImportJob,
  updateUploadSession,
} from './enterpriseImport.service.js';
import {
  acquireEnterpriseImportLock,
  dequeueEnterpriseImportJob,
  enqueueEnterpriseImportJob,
  markEnterpriseImportJobActive,
  markEnterpriseImportJobCompleted,
  markEnterpriseImportJobFailed,
  reconcileEnterpriseImportQueue,
  registerEnterpriseImportWorkerHeartbeat,
  releaseEnterpriseImportLock,
  renewEnterpriseImportLock,
  waitForEnterpriseImportWake,
} from './enterpriseImportQueue.service.js';
import { openR2ObjectStream } from './r2ImportStorage.service.js';
import {
  countEnterpriseCsvRowsFromStream,
  sanitizeFailedRow,
  streamEnterpriseCsvRowsFromStream,
} from './enterpriseCsvParser.service.js';

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

const DEFAULT_BATCH_SIZE = Math.max(1000, readPositiveInteger('IMPORT_DB_BATCH_SIZE', 1000));
const MAX_BATCH_SIZE = 5000;
const BATCH_SIZE = Math.min(MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE);
const PROGRESS_UPDATE_ROWS = Math.max(500, readPositiveInteger('IMPORT_WORKER_PROGRESS_ROWS', 5000));
const PROGRESS_UPDATE_MS = Math.max(1000, readPositiveInteger('IMPORT_WORKER_PROGRESS_MS', 5000));
const LOCK_TTL_SECONDS = Math.max(60, readPositiveInteger('IMPORT_WORKER_LOCK_TTL_SECONDS', 15 * 60));
const MAX_JOB_ATTEMPTS = Math.max(1, readPositiveInteger('IMPORT_WORKER_MAX_ATTEMPTS', 3));
const RETRY_DELAY_BASE_SECONDS = Math.max(1, readPositiveInteger('IMPORT_WORKER_RETRY_BASE_SECONDS', 15));
const RETRY_DELAY_MAX_SECONDS = Math.max(RETRY_DELAY_BASE_SECONDS, readPositiveInteger('IMPORT_WORKER_RETRY_MAX_SECONDS', 5 * 60));
const PRECOUNT_ROWS = readBoolean('IMPORT_WORKER_PRECOUNT_ROWS', false);
const WORKER_HEARTBEAT_MS = Math.max(5000, readPositiveInteger('IMPORT_WORKER_HEARTBEAT_MS', 15000));
const STREAM_STALL_TIMEOUT_MS = Math.max(15_000, readPositiveInteger('IMPORT_WORKER_STREAM_STALL_MS', 120_000));
const STREAM_STALL_CHECK_MS = Math.max(1000, Math.min(15_000, Math.floor(STREAM_STALL_TIMEOUT_MS / 4)));
const RUNNING_JOB_RECLAIM_MS = Math.max(STREAM_STALL_TIMEOUT_MS, readPositiveInteger('IMPORT_WORKER_RUNNING_RECLAIM_MS', 5 * 60 * 1000));
const R2_OPEN_TIMEOUT_MS = Math.max(5000, readPositiveInteger('IMPORT_WORKER_R2_OPEN_TIMEOUT_MS', 30_000));
const INSERT_TIMEOUT_MS = Math.max(10_000, readPositiveInteger('IMPORT_WORKER_INSERT_TIMEOUT_MS', 120_000));
const WORKER_ID = `${process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || 'local'}:${process.pid}:enterprise-import`;

const workerRuntime = {
  workerId: WORKER_ID,
  startedAt: null,
  status: 'stopped',
  concurrency: 0,
  currentJobs: new Map(),
  loops: 0,
  processedJobs: 0,
  failedJobs: 0,
  retriedJobs: 0,
  lastHeartbeatAt: null,
  lastPickupAt: null,
  lastCompletedAt: null,
  lastErrorAt: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function summarizeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 800);
}

function logWorker(message, details = {}) {
  console.info(`[import-worker] ${message}`, details);
}

function warnWorker(message, details = {}) {
  console.warn(`[import-worker] ${message}`, details);
}

function errorWorker(message, details = {}) {
  console.error(`[import-worker] ${message}`, details);
}

function markJobRuntime(jobId, patch = {}) {
  const current = workerRuntime.currentJobs.get(jobId);
  if (current) {
    Object.assign(current, patch, { updatedAt: nowIso() });
  }
}

function isReclaimableRunningJob(job) {
  if (!['counting', 'processing'].includes(String(job?.status || ''))) return false;
  const updatedAt = Date.parse(job.updated_at || job.started_at || job.created_at || 0);
  if (!Number.isFinite(updatedAt)) return false;
  return Date.now() - updatedAt >= RUNNING_JOB_RECLAIM_MS;
}

function isTransientError(error) {
  const message = String(error?.message || error || '');
  return /timeout|timed out|stalled|frozen|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|rate limit|temporarily|503|502|504|429/i.test(message);
}

async function withRetry(fn, {
  attempts = 3,
  baseDelayMs = 500,
  label = 'operation',
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientError(error)) break;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  const err = new Error(`${label} failed: ${lastError?.message || lastError}`);
  err.cause = lastError;
  throw err;
}

function estimateEta(rowsProcessed, totalRows, rowsPerSecond) {
  if (!rowsPerSecond || rowsPerSecond <= 0 || !totalRows || rowsProcessed >= totalRows) return 0;
  return Math.max(0, Math.round((totalRows - rowsProcessed) / rowsPerSecond));
}

function estimateRowsTotalFromBytes(state) {
  const actual = Number(state.totalRows || 0);
  if (actual > 0) return actual;
  const processedRows = Number(state.processedRows || 0);
  const bytesProcessed = Number(state.bytesProcessed || 0);
  const contentLength = Number(state.contentLength || 0);
  if (processedRows <= 0 || bytesProcessed <= 0 || contentLength <= 0) return 0;
  return Math.max(processedRows, Math.ceil((processedRows * contentLength) / bytesProcessed));
}

function currentChunkForRows(rowsProcessed) {
  return rowsProcessed > 0 ? Math.max(1, Math.ceil(rowsProcessed / BATCH_SIZE)) : 0;
}

function totalChunksForState(state) {
  const rowsTotal = estimateRowsTotalFromBytes(state);
  const estimatedChunks = rowsTotal > 0 ? Math.ceil(rowsTotal / BATCH_SIZE) : 0;
  return Math.max(Number(state.currentChunk || 0), Number(state.totalChunks || 0), estimatedChunks);
}

function progressPercentForState(state) {
  const rowsTotal = estimateRowsTotalFromBytes(state);
  const processedRows = Number(state.processedRows || 0);
  if (rowsTotal > 0) return Math.max(0, Math.min(100, Math.floor((processedRows / rowsTotal) * 100)));
  const contentLength = Number(state.contentLength || 0);
  const bytesProcessed = Number(state.bytesProcessed || 0);
  if (contentLength > 0 && bytesProcessed > 0) {
    return Math.max(0, Math.min(99, Math.floor((bytesProcessed / contentLength) * 100)));
  }
  return 0;
}

function buildProgressMetadata(state, status = 'processing') {
  const processedRows = Number(state.processedRows || 0);
  const actualRowsTotal = Number(state.totalRows || 0);
  const estimatedRowsTotal = estimateRowsTotalFromBytes(state);
  const currentChunk = currentChunkForRows(processedRows);
  const totalChunks = totalChunksForState({ ...state, currentChunk });
  state.currentChunk = currentChunk;
  state.totalChunks = totalChunks;

  return {
    ...(state.job?.metadata || {}),
    r2Bucket: state.session?.r2_bucket || state.job?.metadata?.r2Bucket,
    r2Key: state.session?.r2_key || state.job?.metadata?.r2Key,
    lastProgressAt: nowIso(),
    importProgress: {
      ...(state.job?.metadata?.importProgress && typeof state.job.metadata.importProgress === 'object'
        ? state.job.metadata.importProgress
        : {}),
      rowsTotal: actualRowsTotal || estimatedRowsTotal || 0,
      rowsTotalActual: actualRowsTotal || 0,
      rowsTotalEstimated: estimatedRowsTotal || 0,
      processedRows,
      rowsProcessedEffective: processedRows,
      importedRows: Number(state.insertedRows || 0) + Number(state.updatedRows || 0),
      failedRows: Number(state.failedRows || 0),
      remainingRows: estimatedRowsTotal > 0 ? Math.max(0, estimatedRowsTotal - processedRows) : 0,
      rowsPerChunk: BATCH_SIZE,
      currentChunk,
      totalChunks,
      processedChunks: Math.max(0, currentChunk - (state.currentBatchRows ? 1 : 0)),
      failedChunks: Number(state.failedChunks || 0),
      currentChunkRows: Number(state.currentBatchRows || 0),
      currentChunkTotal: BATCH_SIZE,
      chunkSpeedRowsPerSecond: Number(state.lastSpeedRowsPerSecond || 0),
      estimatedRemainingSeconds: Number(state.lastEtaSeconds || 0),
      progressPercent: progressPercentForState(state),
      countMode: PRECOUNT_ROWS ? 'precount' : 'streaming',
      countComplete: actualRowsTotal > 0,
      parserMode: state.parserMode || null,
      parserDelimiter: state.parserDelimiter || null,
      bytesProcessed: Number(state.bytesProcessed || 0),
      bytesTotal: Number(state.contentLength || 0),
      streamChunks: Number(state.streamStats?.chunks || 0),
      phase: state.phase || status,
      importStatus: status,
      lastRowAt: state.lastRowAtMs ? new Date(state.lastRowAtMs).toISOString() : null,
      timingsMs: {
        parserStartup: Number(state.timings?.parserStartupMs || 0),
        streamProbe: Number(state.timings?.streamProbeMs || 0),
        counting: Number(state.timings?.countingMs || 0),
        processing: Date.now() - Number(state.processingStartedAtMs || state.startedAtMs || Date.now()),
        lastInsert: Number(state.timings?.lastInsertMs || 0),
      },
    },
  };
}

function retryDelaySeconds(attempt) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(RETRY_DELAY_MAX_SECONDS, RETRY_DELAY_BASE_SECONDS * (2 ** exponent));
}

async function withOperationTimeout(fn, {
  timeoutMs,
  label,
  jobId = null,
} = {}) {
  let timer = null;
  const startedAt = Date.now();
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label || 'operation'} timed out after ${timeoutMs}ms`);
          err.code = 'IMPORT_OPERATION_TIMEOUT';
          err.jobId = jobId;
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs * 0.75) {
      warnWorker(`${label || 'operation'} slow`, { jobId, elapsedMs, timeoutMs });
    }
  }
}

function asReadableStream(stream) {
  if (!stream) throw new Error('CSV stream is missing');
  if (typeof stream.pipe === 'function') return stream;
  if (typeof stream[Symbol.asyncIterator] === 'function') return Readable.from(stream);
  if (typeof stream.transformToWebStream === 'function') return Readable.fromWeb(stream.transformToWebStream());
  throw new Error('CSV stream is not readable');
}

function createMeteredCsvStream(sourceStream, {
  jobId,
  phase,
  state,
  contentLength = 0,
} = {}) {
  const source = asReadableStream(sourceStream);
  const stats = {
    phase,
    bytes: 0,
    chunks: 0,
    contentLength: Number(contentLength || 0),
    startedAtMs: Date.now(),
    firstByteAtMs: null,
    lastActivityAtMs: Date.now(),
    endedAtMs: null,
    error: null,
  };

  const meter = new Transform({
    transform(chunk, encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
      stats.bytes += size;
      stats.chunks += 1;
      stats.firstByteAtMs = stats.firstByteAtMs || Date.now();
      stats.lastActivityAtMs = Date.now();
      state.bytesProcessed = stats.bytes;
      state.streamStats = stats;
      callback(null, chunk);
    },
  });

  const destroyWith = (error) => {
    stats.error = summarizeError(error);
    meter.destroy(error);
  };

  source.on?.('error', destroyWith);
  meter.on('error', (error) => {
    stats.error = summarizeError(error);
  });
  meter.on('end', () => {
    stats.endedAtMs = Date.now();
  });
  meter.on('close', () => {
    stats.endedAtMs = stats.endedAtMs || Date.now();
  });

  const stallTimer = setInterval(() => {
    if (stats.endedAtMs || meter.destroyed) return;
    const lastProgressAtMs = Math.max(
      stats.lastActivityAtMs || 0,
      state.lastProgressAtMs || 0,
      state.lastInsertAtMs || 0,
    );
    const idleMs = Date.now() - lastProgressAtMs;
    if (idleMs < STREAM_STALL_TIMEOUT_MS) return;
    const error = new Error(`CSV ${phase || 'stream'} stalled for ${idleMs}ms with no bytes or rows`);
    error.code = 'IMPORT_STREAM_STALLED';
    error.diagnostics = {
      jobId,
      phase,
      bytes: stats.bytes,
      chunks: stats.chunks,
      rowsProcessed: state.processedRows,
      checkpointRowNumber: state.checkpointRowNumber,
      parserMode: state.parserMode,
      currentChunk: state.currentChunk,
      totalChunks: state.totalChunks,
    };
    errorWorker('CSV stream stalled', error.diagnostics);
    source.destroy?.(error);
    meter.destroy(error);
  }, STREAM_STALL_CHECK_MS);
  stallTimer.unref?.();

  source.pipe(meter);

  return {
    stream: meter,
    stats,
    stop() {
      clearInterval(stallTimer);
      source.off?.('error', destroyWith);
    },
  };
}

async function openInstrumentedR2Stream({ job, session, state, phase }) {
  const startedAt = Date.now();
  logWorker('Fetching CSV from R2', {
    jobId: job.id,
    phase,
    r2Bucket: session.r2_bucket || job.metadata?.r2Bucket || null,
    r2Key: session.r2_key || job.metadata?.r2Key || null,
  });
  markJobRuntime(job.id, { stage: `r2-${phase}-open`, phase });

  const opened = await withRetry(() => withOperationTimeout(
    () => openR2ObjectStream(session.r2_key),
    { timeoutMs: R2_OPEN_TIMEOUT_MS, label: `R2 ${phase} stream open`, jobId: job.id },
  ), {
    attempts: 3,
    label: `R2 ${phase} stream open`,
  });

  state.contentLength = Number(opened.contentLength || session.size_bytes || state.contentLength || 0);
  const metered = createMeteredCsvStream(opened.stream, {
    jobId: job.id,
    phase,
    state,
    contentLength: state.contentLength,
  });

  logWorker('CSV stream created', {
    jobId: job.id,
    phase,
    openMs: Date.now() - startedAt,
    contentLength: opened.contentLength || null,
    contentType: opened.contentType || null,
    etag: opened.etag || null,
  });

  return {
    ...opened,
    stream: metered.stream,
    stats: metered.stats,
    close: metered.stop,
  };
}

async function writeFailedRow({ jobId, rowNumber, raw, cleaned = null, code, message }) {
  if (!supabase) return;
  await supabase.from('failed_rows').insert({
    import_job_id: jobId,
    row_number: rowNumber,
    raw_row: sanitizeFailedRow(raw || {}),
    cleaned_row: cleaned ? sanitizeFailedRow(cleaned) : null,
    error_code: String(code || 'ROW_FAILED').slice(0, 120),
    error_message: String(message || 'Row failed').slice(0, 2000),
  });
}

async function getExistingFingerprints(fingerprints) {
  if (!fingerprints.length) return new Set();
  const { data, error } = await supabase
    .from('videos')
    .select('video_fingerprint')
    .in('video_fingerprint', fingerprints);
  if (error) throw error;
  return new Set((data || []).map((row) => row.video_fingerprint));
}

function dedupeBatchEntries(entries) {
  const byFingerprint = new Map();
  let localDuplicates = 0;
  for (const entry of entries) {
    const fingerprint = entry.row?.video_fingerprint;
    if (!fingerprint) continue;
    if (byFingerprint.has(fingerprint)) localDuplicates += 1;
    byFingerprint.set(fingerprint, entry);
  }
  return {
    entries: Array.from(byFingerprint.values()),
    localDuplicates,
  };
}

async function upsertVideoEntries(entries, jobId) {
  if (!entries.length) {
    return { inserted: 0, updated: 0, duplicates: 0, failed: 0 };
  }

  const deduped = dedupeBatchEntries(entries);
  const uniqueEntries = deduped.entries;
  const fingerprints = uniqueEntries.map((entry) => entry.row.video_fingerprint);
  const existing = await getExistingFingerprints(fingerprints);

  const payloads = uniqueEntries.map((entry) => ({
    ...entry.row,
    import_job_id: jobId,
    source_row_number: entry.rowNumber,
    updated_at: nowIso(),
  }));

  const { error } = await supabase.from('videos').upsert(payloads, {
    onConflict: 'video_fingerprint',
    ignoreDuplicates: false,
  });
  if (error) throw error;

  return {
    inserted: uniqueEntries.length - existing.size,
    updated: existing.size,
    duplicates: deduped.localDuplicates + existing.size,
    failed: 0,
  };
}

async function flushEntriesWithIsolation(entries, jobId) {
  if (!entries.length) return { inserted: 0, updated: 0, duplicates: 0, failed: 0 };
  try {
    return await withRetry(() => upsertVideoEntries(entries, jobId), {
      attempts: 3,
      label: 'video batch upsert',
    });
  } catch (error) {
    if (entries.length === 1) {
      const entry = entries[0];
      await writeFailedRow({
        jobId,
        rowNumber: entry.rowNumber,
        raw: entry.raw,
        cleaned: entry.row,
        code: 'UPSERT_FAILED',
        message: error?.cause?.message || error?.message || 'Video upsert failed',
      });
      return { inserted: 0, updated: 0, duplicates: 0, failed: 1 };
    }
    const midpoint = Math.ceil(entries.length / 2);
    const left = await flushEntriesWithIsolation(entries.slice(0, midpoint), jobId);
    const right = await flushEntriesWithIsolation(entries.slice(midpoint), jobId);
    return {
      inserted: left.inserted + right.inserted,
      updated: left.updated + right.updated,
      duplicates: left.duplicates + right.duplicates,
      failed: left.failed + right.failed,
    };
  }
}

async function persistProgress(jobId, state, { status = 'processing', force = false } = {}) {
  const totalRows = Number(state.totalRows || 0);
  const estimatedRowsTotal = estimateRowsTotalFromBytes(state);
  const progressTotal = totalRows || estimatedRowsTotal || 0;
  const processedRows = Number(state.processedRows || 0);
  const rowsSincePersist = processedRows - Number(state.lastPersistedRows || 0);
  const msSincePersist = Date.now() - Number(state.lastPersistedAtMs || 0);
  if (!force && rowsSincePersist < PROGRESS_UPDATE_ROWS && msSincePersist < PROGRESS_UPDATE_MS) return state.job;

  state.lastPersistedRows = processedRows;
  state.lastPersistedAtMs = Date.now();
  const elapsedSeconds = Math.max(1, (Date.now() - state.startedAtMs) / 1000);
  const speed = Math.round((Math.max(0, processedRows - state.initialProcessedRows) / elapsedSeconds) * 10) / 10;
  const eta = estimateEta(processedRows, progressTotal, speed);
  state.lastSpeedRowsPerSecond = speed;
  state.lastEtaSeconds = eta;
  state.phase = status;

  const job = await updateImportJob(jobId, {
    status,
    total_rows: totalRows,
    processed_rows: processedRows,
    inserted_rows: Number(state.insertedRows || 0),
    updated_rows: Number(state.updatedRows || 0),
    duplicate_rows: Number(state.duplicateRows || 0),
    failed_rows: Number(state.failedRows || 0),
    checkpoint_row_number: Number(state.checkpointRowNumber || 0),
    speed_rows_per_sec: speed,
    eta_seconds: eta,
    bytes_processed: Number(state.bytesProcessed || state.job?.bytes_processed || 0),
    metadata: buildProgressMetadata(state, status),
  });
  state.job = job;
  logWorker('Progress update sent', {
    jobId,
    status,
    processedRows,
    rowsTotal: totalRows,
    estimatedRowsTotal,
    currentChunk: state.currentChunk || 0,
    totalChunks: state.totalChunks || 0,
    speedRowsPerSecond: speed,
    etaSeconds: eta,
  });
  return job;
}

async function prepareRowsForProcessing(job, session, state) {
  if (Number(job.total_rows || 0) > 0) {
    state.totalRows = Number(job.total_rows || 0);
    if (String(job.status) !== 'processing') {
      state.phase = 'processing';
      state.job = await updateImportJob(job.id, {
        status: 'processing',
        started_at: job.started_at || nowIso(),
        error_message: null,
        metadata: buildProgressMetadata(state, 'processing'),
      });
    }
    logWorker(`Rows counted: ${state.totalRows}`, {
      jobId: job.id,
      source: 'database',
      preCountRows: PRECOUNT_ROWS,
    });
    return state.totalRows;
  }

  state.phase = 'counting';
  const countingStartedAtMs = Date.now();
  logWorker('Counting rows started', {
    jobId: job.id,
    preCountRows: PRECOUNT_ROWS,
    mode: PRECOUNT_ROWS ? 'precount' : 'streaming',
    batchSize: BATCH_SIZE,
  });
  markJobRuntime(job.id, { stage: 'counting', phase: 'counting' });

  state.job = await updateImportJob(job.id, {
    status: 'counting',
    started_at: job.started_at || nowIso(),
    error_message: null,
    metadata: buildProgressMetadata(state, 'counting'),
  });
  if (session?.id) await updateUploadSession(session.id, { status: 'processing' }).catch(() => {});

  if (!PRECOUNT_ROWS) {
    state.timings.countingMs = Date.now() - countingStartedAtMs;
    state.phase = 'processing';
    state.job = await updateImportJob(job.id, {
      status: 'processing',
      started_at: state.job.started_at || nowIso(),
      error_message: null,
      metadata: buildProgressMetadata(state, 'processing'),
    });
    logWorker('Rows counted: 0', {
      jobId: job.id,
      mode: 'deferred-streaming',
      countingMs: state.timings.countingMs,
      note: 'Full pre-count disabled; final row count is discovered during processing.',
    });
    return 0;
  }

  const opened = await openInstrumentedR2Stream({ job, session, state, phase: 'counting' });

  let rowsTotal = 0;
  try {
    rowsTotal = await countEnterpriseCsvRowsFromStream(opened.stream, {
      onStreamProbe: (info) => {
        state.timings.streamProbeMs = info.probeMs;
        logWorker('CSV stream probe completed', { jobId: job.id, phase: 'counting', ...info });
      },
      onParserInitialized: (info) => {
        state.parserMode = info.mode;
        state.parserDelimiter = info.delimiter;
        state.timings.parserStartupMs = info.startupMs;
        logWorker('CSV parser initialized', { jobId: job.id, phase: 'counting', ...info });
      },
      onProgress: async (count) => {
        state.totalRows = count;
        state.processedRows = Number(job.processed_rows || 0);
        state.lastProgressAtMs = Date.now();
        await persistProgress(job.id, state, { status: 'counting', force: true });
      },
    });
  } finally {
    opened.close?.();
  }

  state.totalRows = rowsTotal;
  state.timings.countingMs = Date.now() - countingStartedAtMs;
  logWorker(`Rows counted: ${rowsTotal}`, {
    jobId: job.id,
    countingMs: state.timings.countingMs,
    bytesRead: opened.stats?.bytes || 0,
  });
  state.job = await updateImportJob(job.id, {
    status: 'processing',
    total_rows: rowsTotal,
    bytes_processed: opened.stats?.bytes || opened.contentLength || 0,
    metadata: buildProgressMetadata(state, 'processing'),
  });
  return rowsTotal;
}

function startJobHeartbeat(jobId, state) {
  const timer = setInterval(() => {
    if (['completed', 'failed'].includes(String(state.phase || ''))) return;
    state.lastHeartbeatAtMs = Date.now();
    logWorker(`Worker active - processed ${Number(state.processedRows || 0)} rows`, {
      jobId,
      phase: state.phase || null,
      processedRows: Number(state.processedRows || 0),
      failedRows: Number(state.failedRows || 0),
      insertedRows: Number(state.insertedRows || 0),
      updatedRows: Number(state.updatedRows || 0),
      currentChunk: Number(state.currentChunk || 0),
      totalChunks: Number(state.totalChunks || 0),
      bytesProcessed: Number(state.bytesProcessed || 0),
      bytesTotal: Number(state.contentLength || 0),
      parserMode: state.parserMode || null,
      secondsSinceLastRow: state.lastRowAtMs ? Math.round((Date.now() - state.lastRowAtMs) / 1000) : null,
    });
    markJobRuntime(jobId, {
      stage: state.phase || 'processing',
      processedRows: Number(state.processedRows || 0),
      totalRows: Number(state.totalRows || estimateRowsTotalFromBytes(state) || 0),
      currentChunk: Number(state.currentChunk || 0),
      totalChunks: Number(state.totalChunks || 0),
      bytesProcessed: Number(state.bytesProcessed || 0),
      bytesTotal: Number(state.contentLength || 0),
      parserMode: state.parserMode || null,
    });
    registerEnterpriseImportWorkerHeartbeat({
      workerId: WORKER_ID,
      status: state.phase || 'processing',
      currentJobId: jobId,
      concurrency: workerRuntime.concurrency || 1,
      startedAt: workerRuntime.startedAt,
    }).catch(() => {});
    persistProgress(jobId, state, { status: state.phase === 'counting' ? 'counting' : 'processing' }).catch((error) => {
      warnWorker('Heartbeat progress update failed', { jobId, error: summarizeError(error) });
    });
  }, WORKER_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

async function flushBatchForJob(state, entries, jobId) {
  if (!entries.length) return { inserted: 0, updated: 0, duplicates: 0, failed: 0 };
  const chunkNumber = currentChunkForRows(Number(state.processedRows || 0));
  state.phase = 'processing';
  state.currentChunk = Math.max(Number(state.currentChunk || 0), chunkNumber);
  state.totalChunks = totalChunksForState(state);
  state.currentBatchRows = entries.length;
  state.lastInsertAtMs = Date.now();
  const startedAt = Date.now();

  logWorker(`Processing chunk ${chunkNumber}`, {
    jobId,
    chunk: chunkNumber,
    totalChunks: state.totalChunks || 0,
    rows: entries.length,
    checkpointRowNumber: state.checkpointRowNumber,
  });
  logWorker('Batch insert started', {
    jobId,
    chunk: chunkNumber,
    rows: entries.length,
    timeoutMs: INSERT_TIMEOUT_MS,
  });

  const result = await withOperationTimeout(
    () => flushEntriesWithIsolation(entries, jobId),
    { timeoutMs: INSERT_TIMEOUT_MS, label: 'video batch insert', jobId },
  );

  state.timings.lastInsertMs = Date.now() - startedAt;
  state.lastProgressAtMs = Date.now();
  logWorker('Batch insert completed', {
    jobId,
    chunk: chunkNumber,
    rows: entries.length,
    inserted: result.inserted,
    updated: result.updated,
    duplicates: result.duplicates,
    failed: result.failed,
    durationMs: state.timings.lastInsertMs,
  });
  state.currentBatchRows = 0;
  return result;
}

export async function processEnterpriseImportJob(jobId) {
  if (!supabase) throw new Error('Database unavailable');

  let job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');
  const session = await getUploadSession(job.upload_session_id);
  if (!session) throw new Error('Upload session not found');
  if (!session.r2_key) throw new Error('Upload session is missing its R2 object key');

  const state = {
    job,
    session,
    startedAtMs: Date.now(),
    processingStartedAtMs: Date.now(),
    initialProcessedRows: Number(job.processed_rows || 0),
    totalRows: Number(job.total_rows || 0),
    processedRows: Number(job.processed_rows || 0),
    insertedRows: Number(job.inserted_rows || 0),
    updatedRows: Number(job.updated_rows || 0),
    duplicateRows: Number(job.duplicate_rows || 0),
    failedRows: Number(job.failed_rows || 0),
    checkpointRowNumber: Number(job.checkpoint_row_number || 0),
    lastPersistedRows: Number(job.processed_rows || 0),
    lastPersistedAtMs: 0,
    lastProgressAtMs: Date.now(),
    lastRowAtMs: null,
    lastInsertAtMs: null,
    lastHeartbeatAtMs: null,
    bytesProcessed: Number(job.bytes_processed || 0),
    contentLength: Number(session.size_bytes || job.metadata?.sizeBytes || 0),
    parserMode: null,
    parserDelimiter: null,
    currentChunk: Number(job.metadata?.importProgress?.currentChunk || 0),
    totalChunks: Number(job.metadata?.importProgress?.totalChunks || 0),
    currentBatchRows: 0,
    failedChunks: Number(job.metadata?.importProgress?.failedChunks || 0),
    phase: 'starting',
    timings: {},
  };
  let heartbeatTimer = null;
  let processingStream = null;

  try {
    logWorker('Worker started', {
      jobId: job.id,
      workerId: WORKER_ID,
      status: job.status,
      batchSize: BATCH_SIZE,
      preCountRows: PRECOUNT_ROWS,
      progressUpdateRows: PROGRESS_UPDATE_ROWS,
      progressUpdateMs: PROGRESS_UPDATE_MS,
      streamStallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
      runningJobReclaimMs: RUNNING_JOB_RECLAIM_MS,
    });
    markJobRuntime(job.id, {
      stage: 'starting',
      phase: 'starting',
      totalRows: state.totalRows,
      processedRows: state.processedRows,
      currentChunk: state.currentChunk,
      totalChunks: state.totalChunks,
    });
    heartbeatTimer = startJobHeartbeat(job.id, state);

    if (!['queued', 'counting', 'processing'].includes(String(job.status))) {
      state.phase = 'processing';
      job = await updateImportJob(job.id, {
        status: 'processing',
        started_at: job.started_at || nowIso(),
        error_message: null,
        metadata: buildProgressMetadata(state, 'processing'),
      });
      state.job = job;
    }

    await prepareRowsForProcessing(job, session, state);
    state.processingStartedAtMs = Date.now();
    state.phase = 'processing';

    const opened = await openInstrumentedR2Stream({ job: state.job || job, session, state, phase: 'processing' });
    processingStream = opened;

    logWorker('Chunk generation started', {
      jobId: job.id,
      batchSize: BATCH_SIZE,
      knownRowsTotal: Number(state.totalRows || 0),
      estimatedRowsTotal: estimateRowsTotalFromBytes(state),
      contentLength: state.contentLength || opened.contentLength || 0,
    });
    markJobRuntime(job.id, { stage: 'chunk-generation', phase: 'processing' });

    let rowsSeenThisRun = 0;
    let batch = [];
    for await (const parsed of streamEnterpriseCsvRowsFromStream(opened.stream, {
      onStreamProbe: (info) => {
        state.timings.streamProbeMs = info.probeMs;
        logWorker('CSV stream probe completed', { jobId: job.id, phase: 'processing', ...info });
      },
      onParserInitialized: (info) => {
        state.parserMode = info.mode;
        state.parserDelimiter = info.delimiter;
        state.timings.parserStartupMs = info.startupMs;
        logWorker('CSV parser initialized', { jobId: job.id, phase: 'processing', ...info });
        markJobRuntime(job.id, {
          stage: 'parser-initialized',
          phase: 'processing',
          parserMode: info.mode,
          parserDelimiter: info.delimiter,
        });
      },
    })) {
      if (Number(parsed.rowNumber || 0) <= state.checkpointRowNumber) continue;

      rowsSeenThisRun += 1;
      state.processedRows += 1;
      state.checkpointRowNumber = Number(parsed.rowNumber || state.checkpointRowNumber);
      state.lastRowAtMs = Date.now();
      state.lastProgressAtMs = state.lastRowAtMs;
      const nextChunk = currentChunkForRows(state.processedRows);
      if (nextChunk !== state.currentChunk) {
        state.currentChunk = nextChunk;
        state.totalChunks = totalChunksForState(state);
        logWorker(`Processing chunk ${nextChunk}`, {
          jobId: job.id,
          chunk: nextChunk,
          totalChunks: state.totalChunks || 0,
          rowNumber: parsed.rowNumber,
          processedRows: state.processedRows,
        });
      }

      if (parsed.error) {
        state.failedRows += 1;
        await writeFailedRow({
          jobId: job.id,
          rowNumber: parsed.rowNumber,
          raw: parsed.raw,
          code: parsed.error,
          message: parsed.message,
        });
      } else {
        batch.push({
          rowNumber: parsed.rowNumber,
          raw: parsed.raw,
          row: parsed.row,
        });
      }
      state.currentBatchRows = batch.length;

      if (batch.length >= BATCH_SIZE) {
        const result = await flushBatchForJob(state, batch.splice(0, batch.length), job.id);
        state.insertedRows += result.inserted;
        state.updatedRows += result.updated;
        state.duplicateRows += result.duplicates;
        state.failedRows += result.failed;
        await persistProgress(job.id, state, { status: 'processing', force: true });
      } else if (state.processedRows % PROGRESS_UPDATE_ROWS === 0) {
        await persistProgress(job.id, state, { status: 'processing' });
      }
    }
    processingStream.close?.();
    processingStream = null;
    state.timings.processingMs = Date.now() - state.processingStartedAtMs;
    state.totalRows = Math.max(Number(state.totalRows || 0), Number(state.processedRows || 0));
    state.totalChunks = state.totalRows > 0
      ? Math.max(currentChunkForRows(state.processedRows), Math.ceil(state.totalRows / BATCH_SIZE))
      : totalChunksForState(state);
    logWorker(`Rows counted: ${state.totalRows}`, {
      jobId: job.id,
      mode: PRECOUNT_ROWS ? 'precount-confirmed' : 'streaming-final',
      rowsSeenThisRun,
      processingMs: state.timings.processingMs,
      bytesRead: opened.stats?.bytes || state.bytesProcessed || 0,
    });

    if (batch.length) {
      const result = await flushBatchForJob(state, batch.splice(0, batch.length), job.id);
      state.insertedRows += result.inserted;
      state.updatedRows += result.updated;
      state.duplicateRows += result.duplicates;
      state.failedRows += result.failed;
    }

    state.phase = 'completed';
    job = await persistProgress(job.id, state, { status: 'completed', force: true });
    job = await updateImportJob(job.id, {
      status: 'completed',
      completed_at: nowIso(),
      eta_seconds: 0,
      error_message: null,
      total_rows: state.totalRows,
      processed_rows: state.processedRows,
      metadata: buildProgressMetadata(state, 'completed'),
    });
    await cleanupCompletedUploadObject(job);
    emitEnterpriseImportProgress(job);
    logWorker('Import completed', {
      jobId: job.id,
      totalRows: state.totalRows,
      processedRows: state.processedRows,
      insertedRows: state.insertedRows,
      updatedRows: state.updatedRows,
      duplicateRows: state.duplicateRows,
      failedRows: state.failedRows,
      totalChunks: state.totalChunks,
      durationMs: Date.now() - state.startedAtMs,
    });
    return { success: true, job };
  } catch (error) {
    state.phase = 'failed';
    errorWorker('Import failed', {
      jobId: job.id,
      phase: state.phase,
      message: summarizeError(error),
      processedRows: state.processedRows,
      checkpointRowNumber: state.checkpointRowNumber,
      bytesProcessed: state.bytesProcessed,
      parserMode: state.parserMode,
      currentChunk: state.currentChunk,
      totalChunks: state.totalChunks,
      diagnostics: error?.diagnostics || null,
    });
    await updateImportJob(job.id, {
      status: 'failed',
      error_message: error?.message || 'Import failed',
      attempt_count: Number(job.attempt_count || 0) + 1,
      metadata: buildProgressMetadata(state, 'failed'),
    }).catch(() => null);
    if (session?.id) await updateUploadSession(session.id, { status: 'failed', error_message: error?.message || 'Import failed' }).catch(() => {});
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    processingStream?.close?.();
  }
}

export async function claimNextEnterpriseImportJob() {
  if (!supabase) return null;

  try {
    for (let i = 0; i < 10; i += 1) {
      const jobId = await dequeueEnterpriseImportJob();
      if (!jobId) break;

      const job = await getImportJob(jobId);
      if (!job || (job.status !== 'queued' && !isReclaimableRunningJob(job))) continue;

      const lock = await acquireEnterpriseImportLock(job.id, {
        workerId: WORKER_ID,
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      if (!lock.acquired) continue;
      return { job, lock, source: job.status === 'queued' ? 'redis' : 'redis-running-reclaim' };
    }
  } catch (error) {
    workerRuntime.lastErrorAt = nowIso();
    workerRuntime.lastError = error?.message || String(error);
    throw error;
  }

  await reconcileEnterpriseImportQueue({ source: 'worker-claim' }).catch((error) => {
    console.warn('[enterprise-import-worker] queue reconcile failed:', error?.message || error);
  });

  const { data, error } = await supabase
    .from('import_jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(10);
  if (error) throw error;

  for (const job of data || []) {
    const lock = await acquireEnterpriseImportLock(job.id, {
      workerId: WORKER_ID,
      ttlSeconds: LOCK_TTL_SECONDS,
    });
    if (!lock.acquired) continue;
    return { job, lock, source: 'database-reconcile' };
  }

  const staleBefore = new Date(Date.now() - RUNNING_JOB_RECLAIM_MS).toISOString();
  const { data: running, error: runningError } = await supabase
    .from('import_jobs')
    .select('*')
    .in('status', ['counting', 'processing'])
    .lt('updated_at', staleBefore)
    .order('updated_at', { ascending: true })
    .limit(10);
  if (runningError) throw runningError;

  for (const job of running || []) {
    const lock = await acquireEnterpriseImportLock(job.id, {
      workerId: WORKER_ID,
      ttlSeconds: LOCK_TTL_SECONDS,
    });
    if (!lock.acquired) continue;
    logWorker('Reclaiming stale running job', {
      jobId: job.id,
      status: job.status,
      updatedAt: job.updated_at,
      reclaimAfterMs: RUNNING_JOB_RECLAIM_MS,
    });
    return { job, lock, source: 'database-running-reclaim' };
  }
  return null;
}

async function handleJobFailure(jobId, error) {
  const job = await getImportJob(jobId).catch(() => null);
  const attempt = Number(job?.attempt_count || 0);
  const shouldRetry = isTransientError(error) && attempt < MAX_JOB_ATTEMPTS;

  if (shouldRetry) {
    const delaySeconds = retryDelaySeconds(attempt || 1);
    workerRuntime.retriedJobs += 1;
    await updateImportJob(jobId, {
      status: 'queued',
      error_message: `Retrying after transient error: ${error?.message || error}`,
      ...(job?.status === 'failed' ? {} : { attempt_count: attempt + 1 }),
      metadata: {
        ...(job?.metadata || {}),
        lastRetryAt: nowIso(),
        lastRetryDelaySeconds: delaySeconds,
        lastRetryReason: error?.message || String(error),
      },
    }).catch(() => null);
    await enqueueEnterpriseImportJob(jobId, {
      reason: 'worker-retry',
      source: 'enterpriseImportWorker',
      delaySeconds,
      metadata: { attempt, maxAttempts: MAX_JOB_ATTEMPTS },
    }).catch((enqueueError) => {
      console.warn('[enterprise-import-worker] retry enqueue failed:', enqueueError?.message || enqueueError);
    });
    await markEnterpriseImportJobFailed(jobId, {
      workerId: WORKER_ID,
      error,
      final: false,
      attempt,
    });
    return { retried: true, delaySeconds, attempt };
  }

  await updateImportJob(jobId, {
    status: 'failed',
    error_message: error?.message || 'Import failed',
    ...(job?.status === 'failed' ? {} : { attempt_count: attempt + 1 }),
    metadata: {
      ...(job?.metadata || {}),
      deadLetteredAt: nowIso(),
      deadLetterReason: error?.message || String(error),
    },
  }).catch(() => null);

  await markEnterpriseImportJobFailed(jobId, {
    workerId: WORKER_ID,
    error,
    final: true,
    attempt,
  });
  return { retried: false, attempt };
}

export async function runEnterpriseImportWorkerOnce({ workerIndex = 0 } = {}) {
  const claimed = await claimNextEnterpriseImportJob();
  if (!claimed) return { processed: false };
  const jobId = claimed.job.id;
  workerRuntime.currentJobs.set(jobId, {
    jobId,
    workerIndex,
    source: claimed.source,
    stage: 'claimed',
    phase: 'claimed',
    processedRows: Number(claimed.job.processed_rows || 0),
    totalRows: Number(claimed.job.total_rows || 0),
    currentChunk: Number(claimed.job.metadata?.importProgress?.currentChunk || 0),
    totalChunks: Number(claimed.job.metadata?.importProgress?.totalChunks || 0),
    startedAt: nowIso(),
  });
  workerRuntime.status = 'processing';
  workerRuntime.lastPickupAt = nowIso();
  logWorker('Worker picked up job', {
    jobId,
    workerIndex,
    source: claimed.source,
    status: claimed.job.status,
  });

  let renewTimer = null;
  try {
    await markEnterpriseImportJobActive(jobId, WORKER_ID);
    renewTimer = setInterval(() => {
      renewEnterpriseImportLock(claimed.lock).catch((error) => {
        console.warn('[enterprise-import-worker] lock renewal failed:', error?.message || error);
      });
    }, Math.max(15_000, Math.floor((claimed.lock.ttlSeconds || LOCK_TTL_SECONDS) * 1000 / 3)));
    renewTimer.unref?.();

    const result = await processEnterpriseImportJob(jobId);
    workerRuntime.processedJobs += 1;
    workerRuntime.lastCompletedAt = nowIso();
    await markEnterpriseImportJobCompleted(jobId, WORKER_ID);
    return { processed: true, result };
  } catch (error) {
    workerRuntime.failedJobs += 1;
    workerRuntime.lastErrorAt = nowIso();
    workerRuntime.lastError = error?.message || String(error);
    const retry = await handleJobFailure(jobId, error);
    console.error(`[enterprise-import-worker:${workerIndex}] job failed`, {
      jobId,
      retried: retry.retried,
      attempt: retry.attempt,
      message: error?.message || String(error),
    });
    return { processed: true, failed: true, retry };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    workerRuntime.currentJobs.delete(jobId);
    workerRuntime.status = workerRuntime.currentJobs.size ? 'processing' : 'idle';
    await releaseEnterpriseImportLock(claimed.lock);
  }
}

export async function startEnterpriseImportWorker({
  pollIntervalMs = Number(process.env.IMPORT_WORKER_POLL_MS || 10000),
  concurrency = Number(process.env.IMPORT_WORKER_CONCURRENCY || 1),
  signal = null,
} = {}) {
  workerRuntime.startedAt = workerRuntime.startedAt || nowIso();
  workerRuntime.status = 'starting';
  workerRuntime.concurrency = Math.max(1, concurrency);
  logWorker('Worker started', {
    workerId: WORKER_ID,
    concurrency: workerRuntime.concurrency,
    pollIntervalMs,
    maxAttempts: MAX_JOB_ATTEMPTS,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    batchSize: BATCH_SIZE,
    preCountRows: PRECOUNT_ROWS,
    runningJobReclaimMs: RUNNING_JOB_RECLAIM_MS,
  });
  console.info('[enterprise-import-worker] boot', {
    workerId: WORKER_ID,
    concurrency: workerRuntime.concurrency,
    pollIntervalMs,
    maxAttempts: MAX_JOB_ATTEMPTS,
    lockTtlSeconds: LOCK_TTL_SECONDS,
  });

  const workers = Array.from({ length: Math.max(1, concurrency) }, async (_, index) => {
    while (!signal?.aborted) {
      workerRuntime.loops += 1;
      try {
        await registerEnterpriseImportWorkerHeartbeat({
          workerId: WORKER_ID,
          status: workerRuntime.currentJobs.size ? 'processing' : 'idle',
          currentJobId: workerRuntime.currentJobs.keys().next().value || null,
          concurrency: workerRuntime.concurrency,
          startedAt: workerRuntime.startedAt,
        });
        workerRuntime.lastHeartbeatAt = nowIso();
        const result = await runEnterpriseImportWorkerOnce({ workerIndex: index });
        if (!result.processed) {
          workerRuntime.status = 'idle';
          await waitForEnterpriseImportWake(pollIntervalMs, signal);
        }
      } catch (error) {
        workerRuntime.status = 'error';
        workerRuntime.lastErrorAt = nowIso();
        workerRuntime.lastError = error?.message || String(error);
        console.error(`[enterprise-import-worker:${index}]`, error?.message || error);
        await sleep(Math.min(30_000, pollIntervalMs));
      }
    }
  });
  await Promise.all(workers);
  workerRuntime.status = 'stopped';
  console.info('[enterprise-import-worker] stopped', { workerId: WORKER_ID });
}

export function getEnterpriseImportWorkerRuntimeStatus() {
  return {
    ...workerRuntime,
    config: {
      batchSize: BATCH_SIZE,
      preCountRows: PRECOUNT_ROWS,
      progressUpdateRows: PROGRESS_UPDATE_ROWS,
      progressUpdateMs: PROGRESS_UPDATE_MS,
      heartbeatMs: WORKER_HEARTBEAT_MS,
      streamStallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
      insertTimeoutMs: INSERT_TIMEOUT_MS,
      runningJobReclaimMs: RUNNING_JOB_RECLAIM_MS,
      maxAttempts: MAX_JOB_ATTEMPTS,
    },
    currentJobs: Array.from(workerRuntime.currentJobs.values()),
  };
}
