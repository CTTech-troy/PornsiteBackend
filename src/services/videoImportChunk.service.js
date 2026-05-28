import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { createInterface } from 'readline';
import { createGunzip, createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import unzipper from 'unzipper';
import {
  emitImportProgress,
  getConfiguredImportBatchSize,
  getImportBatch,
  getImportJob,
  listImportBatches,
  logImportError,
  openStagingFileStream,
  saveImportBatch,
  updateImportJobWithMetadata,
} from './videoImport.service.js';
import { countCsvRowsFromStream, normalizeImportRow, streamCsvRowsFromStream } from './videoImportCsv.service.js';
import { prepareVideoImportPayload, upsertVideoPayloadBatch } from './videoImportUpsert.service.js';
import { processDeletedUrlRow } from './videoImportDeletedSync.service.js';
import { enqueueSearchIndex, indexVideoRow } from './searchIndex.service.js';
import { invalidateTopCreatorsCache } from './creatorLeaderboard.service.js';
import {
  createImportWorkDir,
  getLocalChunkPath,
  resolveJobSourcePath,
  statJobSourceFile,
} from './videoImportArchive.service.js';

const MAX_ZIP_ENTRY_BYTES = Number(process.env.IMPORT_MAX_UNCOMPRESSED_BYTES || 5 * 1024 * 1024 * 1024);
const DB_BATCH_SIZE = Math.max(25, Number(process.env.IMPORT_DB_BATCH_SIZE || 250));
const DB_BATCH_DELAY_MS = Math.max(0, Number(process.env.IMPORT_DB_BATCH_DELAY_MS || 25));
const PROGRESS_UPDATE_ROWS = Math.max(50, Number(process.env.IMPORT_PROGRESS_UPDATE_ROWS || 250));
const COUNT_PROGRESS_UPDATE_ROWS = Math.max(10_000, Number(process.env.IMPORT_COUNT_PROGRESS_ROWS || 50_000));
const ALLOWED_ZIP_EXTENSIONS = new Set(['.csv', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.m4v', '.mov']);
const MEDIA_ZIP_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.m4v', '.mov']);

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

class ByteCounter extends Transform {
  constructor() {
    super();
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += Buffer.byteLength(chunk);
    callback(null, chunk);
  }
}

function jobWorkDir(job) {
  return job.metadata?.workDir || path.dirname(resolveJobSourcePath(job));
}

function chunkPathForJob(job, batchNo) {
  return getLocalChunkPath(jobWorkDir(job), batchNo);
}

function computeExtractProgress(bytesProcessed, bytesTotal, chunksTotal) {
  if (bytesTotal > 0) return Math.max(2, Math.min(30, Math.round((bytesProcessed / bytesTotal) * 28)));
  return Math.max(2, Math.min(30, 5 + Math.floor(Number(chunksTotal || 0) / 5)));
}

function computeProcessProgress(rowsProcessed, rowsTotal) {
  if (rowsTotal <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((rowsProcessed / rowsTotal) * 100)));
}

function estimateRemainingSeconds(rowsDone, rowsTotal, rowsPerSecond) {
  if (!rowsPerSecond || rowsPerSecond <= 0 || rowsTotal <= rowsDone) return 0;
  return Math.max(0, Math.round((rowsTotal - rowsDone) / rowsPerSecond));
}

function countProgressFields({
  rowsProcessed = 0,
  rowsTotal = 0,
  rowsOk = 0,
  rowsFailed = 0,
  importStatus = 'processing',
} = {}) {
  const processed = Math.max(0, Number(rowsProcessed || 0));
  const total = Math.max(0, Number(rowsTotal || 0));
  const failed = Math.max(0, Number(rowsFailed || 0));
  return {
    rowsTotal: total,
    rowsProcessedEffective: processed,
    processedRows: processed,
    importedRows: Math.max(0, Number(rowsOk || 0)),
    failedRows: failed,
    remainingRows: total > 0 ? Math.max(0, total - processed) : 0,
    importStatus,
  };
}

async function summarizeBatches(jobId) {
  const batches = await listImportBatches(jobId);
  const totalChunks = batches.length;
  const processedChunks = batches.filter((batch) => String(batch.status || '') === 'completed').length;
  const failedChunks = batches.filter((batch) => String(batch.status || '') === 'failed').length;
  return { batches, totalChunks, processedChunks, failedChunks };
}

async function writeChunkRows({ job, batchNo, rows, rowStart, rowEnd }) {
  const workDir = jobWorkDir(job);
  await fs.promises.mkdir(path.join(workDir, 'chunks'), { recursive: true });
  const chunkPath = chunkPathForJob(job, batchNo);
  const input = Readable.from(rows.map((row) => `${JSON.stringify(row)}\n`));
  await pipeline(input, createGzip(), createWriteStream(chunkPath));

  await saveImportBatch({
    job_id: job.id,
    batch_no: batchNo,
    rows_total: rows.length,
    rows_ok: 0,
    rows_skipped: 0,
    rows_failed: 0,
    cursor_offset: rowEnd,
    status: 'pending',
    chunk_path: chunkPath,
    row_start: rowStart,
    row_end: rowEnd,
    queued_at: new Date().toISOString(),
  });
  return chunkPath;
}

async function splitCsvStreamToChunks({ job, csvStream, batchSize, byteCounter, bytesTotal }) {
  let batchNo = 0;
  let rowsExtracted = 0;
  const expectedTotal = Math.max(
    0,
    Number(job.rows_total || job.metadata?.importProgress?.rowsTotal || 0),
  );
  let currentRows = [];
  let rowStart = null;
  let rowEnd = null;

  const flush = async () => {
    if (!currentRows.length) return;
    await writeChunkRows({ job, batchNo, rows: currentRows, rowStart, rowEnd });
    rowsExtracted += currentRows.length;
    batchNo += 1;
    currentRows = [];
    rowStart = null;
    rowEnd = null;

    const rowsTotal = expectedTotal || rowsExtracted;
    const progressPercent = computeExtractProgress(byteCounter?.bytes || rowsExtracted, bytesTotal, batchNo);
    const updated = await updateImportJobWithMetadata(job.id, {
      importProgress: {
        phase: 'extracting',
        rowsPerChunk: batchSize,
        totalChunks: batchNo,
        ...countProgressFields({
          rowsProcessed: 0,
          rowsTotal,
          rowsOk: 0,
          rowsFailed: 0,
          importStatus: 'extracting',
        }),
        bytesProcessed: byteCounter?.bytes || null,
        bytesTotal: bytesTotal || null,
        extractionComplete: false,
      },
    }, {
      status: 'extracting',
      rows_total: rowsTotal,
      progress_percent: progressPercent,
    });
    Object.assign(job, updated);
  };

  for await (const entry of streamCsvRowsFromStream(csvStream, { normalize: false })) {
    if (rowStart == null) rowStart = entry.rowNumber;
    rowEnd = entry.rowNumber;
    currentRows.push(entry);
    if (currentRows.length >= batchSize) await flush();
  }
  await flush();

  const finalRowsTotal = expectedTotal || rowsExtracted;
  const updated = await updateImportJobWithMetadata(job.id, {
    importProgress: {
      phase: 'chunks_ready',
      rowsPerChunk: batchSize,
      totalChunks: batchNo,
      processedChunks: 0,
      failedChunks: 0,
      currentChunk: batchNo > 0 ? 1 : 0,
      ...countProgressFields({
        rowsProcessed: 0,
        rowsTotal: finalRowsTotal,
        rowsOk: 0,
        rowsFailed: 0,
        importStatus: batchNo > 0 ? 'processing' : 'completed',
      }),
      bytesProcessed: byteCounter?.bytes || null,
      bytesTotal: bytesTotal || null,
      extractionComplete: true,
      extractedAt: new Date().toISOString(),
    },
  }, {
    status: batchNo > 0 ? 'processing' : 'completed',
    rows_total: finalRowsTotal,
    progress_percent: batchNo > 0 ? 0 : 100,
  });
  Object.assign(job, updated);
  return { totalChunks: batchNo, rowsTotal: finalRowsTotal };
}

function assertSafeZipPath(name) {
  const raw = String(name || '');
  if (!raw || raw.includes('..') || raw.startsWith('/') || raw.includes('\\')) {
    throw new Error('Unsafe path in ZIP archive');
  }
  return raw;
}

function isPathInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

async function extractMediaEntry(entry, workDir, entryPath) {
  if (!workDir) {
    entry.autodrain();
    return;
  }
  const dest = path.join(workDir, entryPath);
  if (!isPathInside(workDir, dest)) throw new Error('Zip slip detected');
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(entry, fs.createWriteStream(dest));
}

async function extractZipToChunks({ job, sourceStream, batchSize, byteCounter, bytesTotal, workDir }) {
  let csvFound = false;
  let totalUncompressed = 0;
  const zip = sourceStream.pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of zip) {
    const entryPath = assertSafeZipPath(entry.path);
    const ext = path.extname(entryPath).toLowerCase();
    if (entry.type === 'Directory') {
      entry.autodrain();
      continue;
    }
    if (ext && !ALLOWED_ZIP_EXTENSIONS.has(ext)) {
      entry.autodrain();
      continue;
    }
    totalUncompressed += Number(entry.vars?.uncompressedSize || entry.uncompressedSize || 0);
    if (totalUncompressed > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP extract exceeds max size');

    if (ext === '.csv' && !csvFound) {
      csvFound = true;
      await splitCsvStreamToChunks({ job, csvStream: entry, batchSize, byteCounter, bytesTotal });
    } else if (MEDIA_ZIP_EXTENSIONS.has(ext)) {
      await extractMediaEntry(entry, workDir, entryPath);
    } else {
      entry.autodrain();
    }
  }

  if (!csvFound) throw new Error('No CSV file found in ZIP archive');
}

async function openImportCsvStream(job) {
  const { sourcePath, size: bytesTotal } = await statJobSourceFile(job);
  const sourceFormat = String(job.source_format || 'csv').toLowerCase();
  const fileStream = fs.createReadStream(sourcePath);
  if (sourceFormat === 'gz') {
    return {
      csvStream: fileStream.pipe(createGunzip()),
      bytesTotal: bytesTotal || null,
    };
  }
  if (sourceFormat === 'zip') {
    return {
      zipStream: fileStream,
      bytesTotal: bytesTotal || null,
    };
  }
  if (sourceFormat === 'csv') {
    return {
      csvStream: fileStream,
      bytesTotal: bytesTotal || null,
    };
  }
  throw new Error(`Unsupported source format: ${sourceFormat}`);
}

async function countCsvFromZipStream(sourceStream) {
  let csvFound = false;
  let totalUncompressed = 0;
  let rowCount = 0;
  const zip = sourceStream.pipe(unzipper.Parse({ forceStream: true }));

  for await (const entry of zip) {
    const entryPath = assertSafeZipPath(entry.path);
    const ext = path.extname(entryPath).toLowerCase();
    if (entry.type === 'Directory') {
      entry.autodrain();
      continue;
    }
    if (ext && !ALLOWED_ZIP_EXTENSIONS.has(ext)) {
      entry.autodrain();
      continue;
    }
    totalUncompressed += Number(entry.vars?.uncompressedSize || entry.uncompressedSize || 0);
    if (totalUncompressed > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP extract exceeds max size');

    if (ext === '.csv' && !csvFound) {
      csvFound = true;
      rowCount = await countCsvRowsFromStream(entry);
    } else {
      entry.autodrain();
    }
  }

  if (!csvFound) throw new Error('No CSV file found in ZIP archive');
  return rowCount;
}

export async function countImportSourceRows(jobId) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');

  const existingTotal = Number(job.rows_total || job.metadata?.importProgress?.rowsTotal || 0);
  if (existingTotal > 0 && job.metadata?.importProgress?.countComplete) {
    return existingTotal;
  }

  const startedAt = Date.now();
  const opened = await openImportCsvStream(job);
  const bytesTotal = opened.bytesTotal;

  await updateImportJobWithMetadata(job.id, {
    importProgress: {
      phase: 'counting',
      totalChunks: 0,
      processedChunks: 0,
      failedChunks: 0,
      currentChunk: 0,
      ...countProgressFields({
        rowsProcessed: 0,
        rowsTotal: 0,
        rowsOk: 0,
        rowsFailed: 0,
        importStatus: 'counting',
      }),
      bytesProcessed: 0,
      bytesTotal,
      countComplete: false,
      startedAt: job.metadata?.importProgress?.startedAt || new Date().toISOString(),
    },
  }, {
    status: 'counting',
    progress_percent: 1,
  });

  let rowCount = 0;
  let lastPersistAt = 0;

  const persistCountProgress = async (force = false) => {
    const now = Date.now();
    if (!force && rowCount - lastPersistAt < COUNT_PROGRESS_UPDATE_ROWS) return;
    lastPersistAt = rowCount;
    const elapsedSeconds = Math.max(1, (now - startedAt) / 1000);
    const speed = rowCount / elapsedSeconds;
    const updated = await updateImportJobWithMetadata(job.id, {
      importProgress: {
        phase: 'counting',
        ...countProgressFields({
          rowsProcessed: 0,
          rowsTotal: rowCount,
          rowsOk: 0,
          rowsFailed: 0,
          importStatus: 'counting',
        }),
        chunkSpeedRowsPerSecond: Math.round(speed * 10) / 10,
        bytesTotal,
        countComplete: false,
        updatedAt: new Date().toISOString(),
      },
    }, {
      status: 'counting',
      rows_total: rowCount,
      progress_percent: 1,
    });
    Object.assign(job, updated);
  };

  if (opened.zipStream) {
    rowCount = await countCsvFromZipStream(opened.zipStream);
    await persistCountProgress(true);
  } else {
    for await (const _ of streamCsvRowsFromStream(opened.csvStream, { normalize: false })) {
      rowCount += 1;
      if (rowCount % COUNT_PROGRESS_UPDATE_ROWS === 0) {
        await persistCountProgress(true);
      }
    }
  }

  const updated = await updateImportJobWithMetadata(job.id, {
    importProgress: {
      phase: 'counted',
      ...countProgressFields({
        rowsProcessed: 0,
        rowsTotal: rowCount,
        rowsOk: 0,
        rowsFailed: 0,
        importStatus: 'queued',
      }),
      countComplete: true,
      countedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }, {
    status: 'queued',
    rows_total: rowCount,
    progress_percent: rowCount > 0 ? 2 : 100,
  });
  Object.assign(job, updated);
  return rowCount;
}

export async function extractImportJobToChunks(jobId) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');

  const batchSize = await getConfiguredImportBatchSize(job.metadata?.rowsPerChunk || job.metadata?.importProgress?.rowsPerChunk);
  const knownRowsTotal = Math.max(0, Number(job.rows_total || job.metadata?.importProgress?.rowsTotal || 0));
  const workDir = job.metadata?.workDir || await createImportWorkDir(job.id);
  if (!job.metadata?.workDir) {
    const updatedWorkDir = await updateImportJobWithMetadata(job.id, { workDir, mediaDir: workDir }, {});
    Object.assign(job, updatedWorkDir);
  }
  const opened = await openStagingFileStream(job);
  const byteCounter = new ByteCounter();
  const source = opened.stream.pipe(byteCounter);
  const bytesTotal = Number(opened.contentLength || 0) || null;

  await updateImportJobWithMetadata(job.id, {
    importProgress: {
      phase: 'extracting',
      rowsPerChunk: batchSize,
      totalChunks: 0,
      processedChunks: 0,
      failedChunks: 0,
      ...countProgressFields({
        rowsProcessed: 0,
        rowsTotal: knownRowsTotal,
        rowsOk: 0,
        rowsFailed: 0,
        importStatus: 'extracting',
      }),
      bytesProcessed: 0,
      bytesTotal,
      extractionComplete: false,
      startedAt: job.metadata?.importProgress?.startedAt || new Date().toISOString(),
    },
  }, {
    status: 'extracting',
    progress_percent: 2,
  });

  const sourceFormat = String(job.source_format || 'csv').toLowerCase();
  if (sourceFormat === 'zip') {
    await updateImportJobWithMetadata(job.id, {
      workDir,
      mediaDir: workDir,
      importProgress: {
        phase: 'extracting',
        rowsPerChunk: batchSize,
        bytesTotal,
      },
    }, {
      status: 'extracting',
    });
    await extractZipToChunks({ job, sourceStream: source, batchSize, byteCounter, bytesTotal, workDir });
  } else if (sourceFormat === 'gz' || sourceFormat === 'csv') {
    const csvStream = sourceFormat === 'gz' ? source.pipe(createGunzip()) : source;
    await splitCsvStreamToChunks({ job, csvStream, batchSize, byteCounter, bytesTotal });
  } else {
    throw new Error(`Unsupported source format: ${sourceFormat}`);
  }

  return summarizeBatches(job.id);
}

async function* streamChunkRows(chunkPath) {
  const lines = createInterface({
    input: fs.createReadStream(chunkPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

async function indexImportedRows(rows) {
  for (const row of rows || []) {
    try {
      await indexVideoRow(row);
    } catch (err) {
      await enqueueSearchIndex(row.video_id, 'upsert').catch(() => {});
      console.warn('[import] index deferred:', err?.message);
    }
  }
}

async function updatePartialChunkProgress({ job, batch, partialRows, startedAt }) {
  const rowsCommitted = Number(job.rows_processed || 0);
  const rowsTotal = Number(job.rows_total || job.metadata?.importProgress?.rowsTotal || 0);
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  const speed = partialRows / elapsedSeconds;
  const effectiveRows = rowsCommitted + partialRows;
  const progressPercent = computeProcessProgress(effectiveRows, rowsTotal);
  const summary = await summarizeBatches(job.id);
  const updated = await updateImportJobWithMetadata(job.id, {
    importProgress: {
      phase: 'processing',
      totalChunks: summary.totalChunks,
      processedChunks: summary.processedChunks,
      failedChunks: summary.failedChunks,
      currentChunk: Number(batch.batch_no) + 1,
      currentChunkRows: partialRows,
      currentChunkTotal: Number(batch.rows_total || 0),
      rowsPerChunk: job.metadata?.importProgress?.rowsPerChunk || Number(batch.rows_total || 0),
      ...countProgressFields({
        rowsProcessed: effectiveRows,
        rowsTotal,
        rowsOk: Number(job.rows_ok || 0),
        rowsFailed: Number(job.rows_failed || 0),
        importStatus: 'processing',
      }),
      chunkSpeedRowsPerSecond: Math.round(speed * 10) / 10,
      estimatedRemainingSeconds: estimateRemainingSeconds(effectiveRows, rowsTotal, speed),
      updatedAt: new Date().toISOString(),
    },
  }, {
    status: 'processing',
    progress_percent: progressPercent,
  });
  Object.assign(job, updated);
}

async function flushPayloadBatch({ payloadEntries, jobId }) {
  if (!payloadEntries.length) return { ok: 0, failed: 0 };
  const entries = payloadEntries.splice(0, payloadEntries.length);
  try {
    const result = await upsertVideoPayloadBatch(entries.map((entry) => entry.payload));
    await indexImportedRows(result.data || []);
    if (DB_BATCH_DELAY_MS) await sleep(DB_BATCH_DELAY_MS);
    return { ok: entries.length, failed: 0 };
  } catch (err) {
    let ok = 0;
    let failed = 0;
    for (const entry of entries) {
      try {
        const result = await upsertVideoPayloadBatch([entry.payload]);
        await indexImportedRows(result.data || []);
        ok += 1;
      } catch (rowErr) {
        failed += 1;
        await logImportError(jobId, entry.rowNumber, entry.raw, 'UPSERT_FAILED', rowErr?.message || err?.message);
      }
    }
    if (DB_BATCH_DELAY_MS) await sleep(DB_BATCH_DELAY_MS);
    return { ok, failed };
  }
}

export async function processImportChunk(jobId, batchNo) {
  const job = await getImportJob(jobId);
  if (!job) throw new Error('Import job not found');
  const batch = await getImportBatch(jobId, Number(batchNo));
  if (!batch) throw new Error(`Import chunk ${batchNo} not found`);
  if (String(batch.status || '') === 'completed') {
    return { skipped: true, completed: true, batchNo: Number(batchNo), summary: await summarizeBatches(jobId) };
  }
  if (!batch.chunk_path) throw new Error(`Import chunk ${batchNo} has no chunk path`);

  const startedAt = Date.now();
  const attempt = Number(batch.attempts || 0) + 1;
  await saveImportBatch({
    ...batch,
    status: 'processing',
    attempts: attempt,
    started_at: new Date().toISOString(),
    error_summary: null,
  });
  await updatePartialChunkProgress({ job, batch, partialRows: 0, startedAt });

  let processed = 0;
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const payloadEntries = [];
  const cutoffDate = job.import_type === 'last_7_days'
    ? new Date(Date.now() - 7 * 86400000)
    : null;

  try {
    for await (const entry of streamChunkRows(batch.chunk_path)) {
      processed += 1;
      const parsed = { ...entry, ...normalizeImportRow(entry.raw || {}) };

      if (job.import_type === 'deleted_urls') {
        const url = parsed.raw?.embed_url || parsed.raw?.url || parsed.raw?.title;
        try {
          await processDeletedUrlRow(jobId, url);
          ok += 1;
        } catch (err) {
          failed += 1;
          await logImportError(jobId, parsed.rowNumber, parsed.raw, 'DELETE_FAILED', err?.message);
        }
      } else if (parsed.error) {
        skipped += 1;
        await logImportError(jobId, parsed.rowNumber, parsed.raw, parsed.error, parsed.message);
      } else if (cutoffDate && parsed.row?.metadata?.created_at && new Date(parsed.row.metadata.created_at) < cutoffDate) {
        skipped += 1;
      } else {
        try {
          const prepared = await prepareVideoImportPayload({
            job,
            parsedRow: parsed,
            mediaDir: job.metadata?.mediaDir || null,
            importType: job.import_type,
          });
          if (prepared.skipped) {
            skipped += 1;
          } else {
            payloadEntries.push({
              payload: prepared.payload,
              rowNumber: parsed.rowNumber,
              raw: parsed.raw,
            });
          }
        } catch (err) {
          failed += 1;
          await logImportError(jobId, parsed.rowNumber, parsed.raw, 'VALIDATION_FAILED', err?.message);
        }
      }

      if (payloadEntries.length >= DB_BATCH_SIZE) {
        const result = await flushPayloadBatch({ payloadEntries, jobId });
        ok += result.ok;
        failed += result.failed;
      }

      if (processed % PROGRESS_UPDATE_ROWS === 0) {
        await updatePartialChunkProgress({ job, batch, partialRows: processed, startedAt });
      }
    }

    const result = await flushPayloadBatch({ payloadEntries, jobId });
    ok += result.ok;
    failed += result.failed;

    const latestJob = await getImportJob(jobId);
    const committedRows = Number(latestJob.rows_processed || 0) + processed;
    const rowsTotal = Number(latestJob.rows_total || job.rows_total || 0);
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const speed = processed / elapsedSeconds;

    await saveImportBatch({
      ...batch,
      status: 'completed',
      rows_total: processed,
      rows_ok: ok,
      rows_skipped: skipped,
      rows_failed: failed,
      attempts: attempt,
      completed_at: new Date().toISOString(),
      error_summary: null,
    });

    const summary = await summarizeBatches(jobId);
    const updated = await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'processing',
        totalChunks: summary.totalChunks,
        processedChunks: summary.processedChunks,
        failedChunks: summary.failedChunks,
        currentChunk: Number(batch.batch_no) + 1,
        currentChunkRows: processed,
        currentChunkTotal: processed,
        ...countProgressFields({
          rowsProcessed: committedRows,
          rowsTotal,
          rowsOk: Number(latestJob.rows_ok || 0) + ok,
          rowsFailed: Number(latestJob.rows_failed || 0) + failed,
          importStatus: 'processing',
        }),
        rowsPerChunk: latestJob.metadata?.importProgress?.rowsPerChunk || Number(batch.rows_total || 0),
        chunkSpeedRowsPerSecond: Math.round(speed * 10) / 10,
        estimatedRemainingSeconds: estimateRemainingSeconds(committedRows, rowsTotal, speed),
        updatedAt: new Date().toISOString(),
      },
    }, {
      status: 'processing',
      rows_processed: committedRows,
      rows_ok: Number(latestJob.rows_ok || 0) + ok,
      rows_skipped: Number(latestJob.rows_skipped || 0) + skipped,
      rows_failed: Number(latestJob.rows_failed || 0) + failed,
      progress_percent: computeProcessProgress(committedRows, rowsTotal),
    });
    emitImportProgress(updated);
    if (ok > 0) invalidateTopCreatorsCache();

    return {
      completed: true,
      batchNo: Number(batchNo),
      processed,
      ok,
      skipped,
      failed,
      summary,
    };
  } catch (err) {
    await saveImportBatch({
      ...batch,
      status: 'failed',
      rows_total: Number(batch.rows_total || processed),
      rows_ok: ok,
      rows_skipped: skipped,
      rows_failed: failed,
      attempts: attempt,
      error_summary: err?.message || 'Chunk failed',
    });
    const summary = await summarizeBatches(jobId);
    const latestJob = await getImportJob(jobId).catch(() => job);
    const rowsTotal = Number(latestJob?.rows_total || job.rows_total || batch.rows_total || 0);
    const rowsProcessed = Number(latestJob?.rows_processed || job.rows_processed || 0);
    await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'failed',
        totalChunks: summary.totalChunks,
        processedChunks: summary.processedChunks,
        failedChunks: summary.failedChunks,
        currentChunk: Number(batch.batch_no) + 1,
        currentChunkRows: processed,
        currentChunkTotal: Number(batch.rows_total || 0),
        ...countProgressFields({
          rowsProcessed,
          rowsTotal,
          rowsOk: Number(latestJob?.rows_ok || job.rows_ok || 0),
          rowsFailed: Number(latestJob?.rows_failed || job.rows_failed || 0) + failed,
          importStatus: 'failed',
        }),
        updatedAt: new Date().toISOString(),
      },
    }, {
      status: 'failed',
      error_summary: err?.message || 'Chunk failed',
    });
    throw err;
  }
}

export async function getNextChunkToProcess(jobId, afterBatchNo = null, { failedOnly = false } = {}) {
  const { batches } = await summarizeBatches(jobId);
  const startAfter = afterBatchNo == null ? -1 : Number(afterBatchNo);
  return batches.find((batch) => {
    const status = String(batch.status || 'pending');
    if (Number(batch.batch_no) <= startAfter) return false;
    if (failedOnly) return status === 'failed';
    return !['completed', 'skipped'].includes(status);
  }) || null;
}

export async function getImportChunkSummary(jobId) {
  return summarizeBatches(jobId);
}
