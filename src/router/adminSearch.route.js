import { Router } from 'express';
import * as ctrl from '../controller/adminSearch.controller.js';

const router = Router();

router.get('/dashboard', ctrl.getSearchDashboard);
router.get('/preview', ctrl.previewSearch);
router.post('/reindex', ctrl.reindexAll);
router.post('/reindex/:target', ctrl.reindexTarget);
router.post('/clear', ctrl.clearIndexes);
router.post('/sync-queue', ctrl.processQueue);
router.post('/sync-batches', ctrl.processBatches);
router.post('/pause', ctrl.pauseIndexing);
router.post('/resume', ctrl.resumeIndexing);
router.post('/retry-failed', ctrl.retryFailedBatches);

export default router;
