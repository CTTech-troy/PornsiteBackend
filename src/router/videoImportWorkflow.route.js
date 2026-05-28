import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  enqueueImportStep,
  finalizeImportJob,
  getImportJob,
  updateImportJob,
  updateImportJobWithMetadata,
} from '../services/videoImport.service.js';
import {
  countImportSourceRows,
  extractImportJobToChunks,
  getImportChunkSummary,
  getNextChunkToProcess,
  processImportChunk,
} from '../services/videoImportChunk.service.js';
import { cleanupImportWorkDir } from '../services/videoImportArchive.service.js';
import { processSearchIndexQueue } from '../services/searchIndex.service.js';
import { supabase } from '../config/supabase.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

function countProgressFields(job = {}, importStatus = job.status || 'processing') {
  const rowsTotal = Math.max(0, Number(job.rows_total || job.metadata?.importProgress?.rowsTotal || 0));
  const rowsProcessed = Math.max(0, Number(job.rows_processed || job.metadata?.importProgress?.rowsProcessedEffective || 0));
  const rowsFailed = Math.max(0, Number(job.rows_failed || job.metadata?.importProgress?.failedRows || 0));
  return {
    rowsTotal,
    rowsProcessedEffective: rowsProcessed,
    processedRows: rowsProcessed,
    importedRows: Math.max(0, Number(job.rows_ok || 0)),
    failedRows: rowsFailed,
    remainingRows: rowsTotal > 0 ? Math.max(0, rowsTotal - rowsProcessed) : 0,
    importStatus,
  };
}

router.post('/count', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });

  try {
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const rowsTotal = await countImportSourceRows(jobId);
    if (rowsTotal <= 0) {
      await updateImportJobWithMetadata(jobId, {
        importProgress: {
          phase: 'completed',
          totalChunks: 0,
          processedChunks: 0,
          failedChunks: 0,
          ...countProgressFields(job, 'completed'),
          countComplete: true,
          extractionComplete: true,
        },
      }, {
        status: 'completed',
        progress_percent: 100,
        completed_at: new Date().toISOString(),
      });
      await finalizeImportJob(jobId, { success: true });
      return res.json({ success: true, rowsTotal: 0, queued: false });
    }

    await enqueueImportStep(jobId, 'extract');
    return res.json({ success: true, rowsTotal, queued: true });
  } catch (err) {
    const failedJob = await getImportJob(jobId).catch(() => null);
    await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'failed',
        error: err?.message || 'Count failed',
        importStatus: 'failed',
        updatedAt: new Date().toISOString(),
      },
    }, {
      status: 'failed',
      error_summary: err?.message || 'Count failed',
    }).catch(() => {});
    if (failedJob?.metadata?.workDir) await cleanupImportWorkDir(failedJob.metadata.workDir).catch(() => {});
    await finalizeImportJob(jobId, { success: false, errorSummary: err?.message }).catch(() => {});
    return res.status(500).json({ success: false, message: err?.message || 'Count failed' });
  }
});

router.post('/extract', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });

  try {
    const job = await getImportJob(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    const summary = await extractImportJobToChunks(jobId);
    if (summary.totalChunks > 0) {
      const next = await getNextChunkToProcess(jobId);
      if (next) await enqueueImportStep(jobId, 'process-chunk', { batchNo: next.batch_no });
      return res.json({
        success: true,
        queued: Boolean(next),
        totalChunks: summary.totalChunks,
        rowsTotal: summary.batches.reduce((sum, batch) => sum + Number(batch.rows_total || 0), 0),
      });
    }

    await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'completed',
        totalChunks: 0,
        processedChunks: 0,
        failedChunks: 0,
        ...countProgressFields(job, 'completed'),
        extractionComplete: true,
      },
    }, {
      status: 'completed',
      progress_percent: 100,
      completed_at: new Date().toISOString(),
    });
    await finalizeImportJob(jobId, { success: true });
    return res.json({ success: true, queued: false, totalChunks: 0, rowsTotal: 0 });
  } catch (err) {
    const failedJob = await getImportJob(jobId).catch(() => null);
    if (failedJob?.metadata?.workDir) await cleanupImportWorkDir(failedJob.metadata.workDir).catch(() => {});
    await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'failed',
        error: err?.message || 'Extract failed',
        updatedAt: new Date().toISOString(),
      },
    }, {
      status: 'failed',
      error_summary: err?.message || 'Extract failed',
    }).catch(() => {});
    await finalizeImportJob(jobId, { success: false, errorSummary: err?.message }).catch(() => {});
    return res.status(500).json({ success: false, message: err?.message || 'Extract failed' });
  }
});

async function processChunkRequest(req, res) {
  const jobId = req.body?.jobId;
  const batchNo = Number(req.body?.batchNo ?? req.body?.batch_no ?? 0);
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });

  try {
    const result = await processImportChunk(jobId, batchNo);
    const summary = await getImportChunkSummary(jobId);
    const next = await getNextChunkToProcess(jobId, batchNo);

    if (next) {
      await enqueueImportStep(jobId, 'process-chunk', { batchNo: next.batch_no });
      return res.json({ success: true, continued: true, nextBatchNo: next.batch_no, ...result });
    }

    if (summary.failedChunks > 0) {
      await updateImportJobWithMetadata(jobId, {
        importProgress: {
          phase: 'failed',
          totalChunks: summary.totalChunks,
          processedChunks: summary.processedChunks,
          failedChunks: summary.failedChunks,
          ...countProgressFields(await getImportJob(jobId).catch(() => ({})), 'failed'),
          updatedAt: new Date().toISOString(),
        },
      }, {
        status: 'failed',
        error_summary: `${summary.failedChunks} import chunk(s) failed`,
      });
      await finalizeImportJob(jobId, { success: false, errorSummary: `${summary.failedChunks} import chunk(s) failed` });
      return res.status(500).json({ success: false, message: `${summary.failedChunks} import chunk(s) failed` });
    }

    await enqueueImportStep(jobId, 'finalize');
    return res.json({ success: true, continued: false, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Chunk import failed' });
  }
}

router.post('/process-chunk', processChunkRequest);

router.post('/parse-batch', async (req, res) => {
  req.body.batchNo = Number(req.body?.batchNo ?? req.body?.batch_no ?? 0);
  return processChunkRequest(req, res);
});

router.post('/finalize', async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ success: false, message: 'jobId required' });
  try {
    const job = await getImportJob(jobId);
    const summary = await getImportChunkSummary(jobId);
    if (summary.failedChunks > 0) {
      await updateImportJobWithMetadata(jobId, {
        importProgress: {
          phase: 'failed',
          totalChunks: summary.totalChunks,
          processedChunks: summary.processedChunks,
          failedChunks: summary.failedChunks,
          ...countProgressFields(job, 'failed'),
          updatedAt: new Date().toISOString(),
        },
      }, {
        status: 'failed',
        error_summary: `${summary.failedChunks} import chunk(s) failed`,
      });
      await finalizeImportJob(jobId, { success: false, errorSummary: `${summary.failedChunks} import chunk(s) failed` });
      return res.status(500).json({ success: false, message: `${summary.failedChunks} import chunk(s) failed` });
    }

    await updateImportJobWithMetadata(jobId, {
      importProgress: {
        phase: 'completed',
        totalChunks: summary.totalChunks,
        processedChunks: summary.processedChunks,
        failedChunks: 0,
        currentChunk: summary.totalChunks,
        currentChunkRows: 0,
        ...countProgressFields(job, 'completed'),
        estimatedRemainingSeconds: 0,
        completedAt: new Date().toISOString(),
      },
    }, {
      status: 'completed',
      progress_percent: 100,
      completed_at: new Date().toISOString(),
    });
    if (job?.metadata?.workDir) await cleanupImportWorkDir(job.metadata.workDir).catch(() => {});
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
