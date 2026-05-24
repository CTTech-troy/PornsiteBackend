import { Router } from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  getImportJob,
  updateImportJob,
  downloadStagingFile,
  getImportCursor,
  setImportCursor,
  logImportError,
  enqueueImportStep,
  finalizeImportJob,
} from '../services/videoImport.service.js';
import {
  createImportWorkDir,
  cleanupImportWorkDir,
  extractArchiveToWorkDir,
} from '../services/videoImportArchive.service.js';
import { streamCsvRows } from '../services/videoImportCsv.service.js';
import { importVideoRow } from '../services/videoImportUpsert.service.js';
import { processDeletedUrlRow } from '../services/videoImportDeletedSync.service.js';
import { processSearchIndexQueue } from '../services/searchIndex.service.js';
import { supabase } from '../config/supabase.js';

const router = Router();
const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/extract', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });

  let workDir = null;
  try {
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    await updateImportJob(jobId, { status: 'extracting', progress_percent: 5 });
    workDir = await createImportWorkDir(jobId);
    const localSource = path.join(workDir, `source.${job.source_format}`);
    await downloadStagingFile(job.staging_path, localSource);

    const { csvPath, mediaDir } = await extractArchiveToWorkDir({
      sourcePath: localSource,
      sourceFormat: job.source_format,
      workDir,
    });

    await updateImportJob(jobId, {
      status: 'processing',
      progress_percent: 10,
      metadata: { ...(job.metadata || {}), csvPath, mediaDir, workDir },
    });

    await enqueueImportStep(jobId, 'parse-batch', { offset: 0 });
    return res.json({ success: true, csvPath });
  } catch (err) {
    await updateImportJob(jobId, { status: 'failed', error_summary: err?.message });
    await finalizeImportJob(jobId, { success: false, errorSummary: err?.message });
    if (workDir) await cleanupImportWorkDir(workDir);
    return res.status(500).json({ success: false, message: err?.message || 'Extract failed' });
  }
});

router.post('/parse-batch', async (req, res) => {
  const jobId = req.body?.jobId;
  const offset = Number(req.body?.offset ?? await getImportCursor(jobId)) || 0;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });

  try {
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const csvPath = job.metadata?.csvPath;
    const mediaDir = job.metadata?.mediaDir;
    if (!csvPath || !fs.existsSync(csvPath)) {
      throw new Error('CSV path missing — re-run extract');
    }

    let processed = 0;
    let ok = Number(job.rows_ok) || 0;
    let skipped = Number(job.rows_skipped) || 0;
    let failed = Number(job.rows_failed) || 0;
    let cursor = offset;

    if (job.import_type === 'deleted_urls') {
      for await (const entry of streamCsvRows(csvPath, { offset })) {
        if (processed >= BATCH_SIZE) break;
        const url = entry.raw?.embed_url || entry.raw?.url || entry.raw?.title;
        try {
          await processDeletedUrlRow(jobId, url);
          ok += 1;
        } catch (err) {
          failed += 1;
          await logImportError(jobId, entry.rowNumber, entry.raw, 'DELETE_FAILED', err?.message);
        }
        processed += 1;
        cursor = entry.rowNumber;
      }
    } else {
      const cutoffDate = job.import_type === 'last_7_days'
        ? new Date(Date.now() - 7 * 86400000)
        : null;

      for await (const entry of streamCsvRows(csvPath, { offset })) {
        if (processed >= BATCH_SIZE) break;
        if (entry.error) {
          skipped += 1;
          await logImportError(jobId, entry.rowNumber, entry.raw, entry.error, entry.message);
          processed += 1;
          cursor = entry.rowNumber;
          continue;
        }
        if (cutoffDate && entry.row?.metadata?.created_at) {
          const created = new Date(entry.row.metadata.created_at);
          if (created < cutoffDate) {
            skipped += 1;
            processed += 1;
            cursor = entry.rowNumber;
            continue;
          }
        }
        try {
          const result = await importVideoRow({
            job,
            parsedRow: entry,
            mediaDir,
            importType: job.import_type,
          });
          if (result.skipped) skipped += 1;
          else ok += 1;
        } catch (err) {
          failed += 1;
          await logImportError(jobId, entry.rowNumber, entry.raw, 'UPSERT_FAILED', err?.message);
        }
        processed += 1;
        cursor = entry.rowNumber;
      }
    }

    const rowsProcessed = (Number(job.rows_processed) || 0) + processed;
    const progress = Math.min(95, 10 + Math.floor((rowsProcessed / Math.max(rowsProcessed + BATCH_SIZE, 1)) * 80));

    await updateImportJob(jobId, {
      rows_processed: rowsProcessed,
      rows_ok: ok,
      rows_skipped: skipped,
      rows_failed: failed,
      progress_percent: progress,
    });
    await setImportCursor(jobId, cursor + 1);

    if (processed >= BATCH_SIZE) {
      await enqueueImportStep(jobId, 'parse-batch', { offset: cursor + 1 });
      return res.json({ success: true, continued: true, processed, cursor });
    }

    await enqueueImportStep(jobId, 'finalize');
    return res.json({ success: true, continued: false, processed });
  } catch (err) {
    await updateImportJob(jobId, { status: 'failed', error_summary: err?.message });
    await finalizeImportJob(jobId, { success: false, errorSummary: err?.message });
    return res.status(500).json({ success: false, message: err?.message || 'Parse failed' });
  }
});

router.post('/finalize', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });
  try {
    const job = await getImportJob(jobId);
    if (job?.metadata?.workDir) {
      await cleanupImportWorkDir(job.metadata.workDir);
    }
    await updateImportJob(jobId, { status: 'completed', progress_percent: 100 });
    await finalizeImportJob(jobId, { success: true });
    await enqueueImportStep(jobId, 'search-sync', {});
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Finalize failed' });
  }
});

router.post('/rollback', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });
  try {
    if (supabase) {
      await supabase.from('tiktok_videos').update({
        deleted_at: new Date().toISOString(),
        is_live: false,
        status: 'removed',
      }).eq('import_job_id', jobId);
    }
    await updateImportJob(jobId, { status: 'rolled_back' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Rollback failed' });
  }
});

router.post('/search-sync', async (req, res) => {
  try {
    const result = await processSearchIndexQueue(200);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Search sync failed' });
  }
});

router.post('/reconcile', async (req, res) => {
  try {
    if (!supabase) return res.json({ success: true, reconciled: 0 });
    const staleBefore = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data: stuck } = await supabase
      .from('video_import_jobs')
      .select('id')
      .in('status', ['extracting', 'processing', 'queued'])
      .lt('updated_at', staleBefore);
    for (const row of stuck || []) {
      await updateImportJob(row.id, { status: 'failed', error_summary: 'Stale job reconciled' });
    }
    return res.json({ success: true, reconciled: (stuck || []).length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Reconcile failed' });
  }
});

export default router;
