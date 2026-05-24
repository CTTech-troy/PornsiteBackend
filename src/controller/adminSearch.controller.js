import {
  clearSearchIndexes,
  getSearchAdminStats,
  processSearchIndexBatches,
  processSearchIndexQueue,
  reindexAllContent,
  reindexSearchTarget,
  retryFailedSearchBatches,
  searchAllContent,
  setIndexingPaused,
} from '../services/searchIndex.service.js';

function adminId(req) {
  return req.admin?.id || req.admin?.email || req.user?.id || null;
}

export async function getSearchDashboard(req, res) {
  try {
    const data = await getSearchAdminStats();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed to load search dashboard' });
  }
}

export async function previewSearch(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const data = q ? await searchAllContent(q, { limit, includeUsers: true }) : {};
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Search preview failed' });
  }
}

export async function reindexAll(req, res) {
  try {
    const data = await reindexAllContent({ startedBy: adminId(req), batchSize: req.body?.batchSize });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Reindex failed' });
  }
}

export async function reindexTarget(req, res) {
  try {
    const target = req.params.target || req.body?.target || 'all';
    const data = await reindexSearchTarget(target, { startedBy: adminId(req), batchSize: req.body?.batchSize });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Target reindex failed' });
  }
}

export async function clearIndexes(req, res) {
  try {
    const indexes = Array.isArray(req.body?.indexes) ? req.body.indexes : undefined;
    const data = await clearSearchIndexes(indexes);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Clear indexes failed' });
  }
}

export async function processQueue(req, res) {
  try {
    const batchSize = Math.min(5000, Math.max(1, parseInt(req.body?.batchSize ?? req.query?.batchSize, 10) || 100));
    const data = await processSearchIndexQueue(batchSize);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Queue sync failed' });
  }
}

export async function processBatches(req, res) {
  try {
    const workers = Math.min(10, Math.max(1, parseInt(req.body?.workers ?? req.query?.workers, 10) || 5));
    const data = await processSearchIndexBatches(workers);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Batch sync failed' });
  }
}

export async function pauseIndexing(req, res) {
  try {
    const data = await setIndexingPaused(true, { reason: req.body?.reason || 'Paused from admin dashboard', updatedBy: adminId(req) });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Pause indexing failed' });
  }
}

export async function resumeIndexing(req, res) {
  try {
    const data = await setIndexingPaused(false, { reason: req.body?.reason || null, updatedBy: adminId(req) });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Resume indexing failed' });
  }
}

export async function retryFailedBatches(req, res) {
  try {
    const data = await retryFailedSearchBatches({ runId: req.body?.runId || null, target: req.body?.target || null });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Retry failed batches failed' });
  }
}
