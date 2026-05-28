import { Router } from 'express';
import * as ctrl from '../controller/adminVideoImport.controller.js';
import {
  importUploadSessionLimiter,
  requireImportPermission,
} from '../services/enterpriseImport.service.js';

const router = Router();

router.use(requireImportPermission);

router.get('/analytics', ctrl.getAnalytics);
router.get('/queue/health', ctrl.getQueueHealth);
router.post('/queue/reconcile', ctrl.reconcileQueue);
router.get('/events', ctrl.importEventsStream);
router.get('/jobs', ctrl.listJobs);
router.get('/jobs/:jobId', ctrl.getJob);
router.get('/jobs/:jobId/failed-rows', ctrl.getJobErrors);
router.delete('/delete-all', ctrl.deleteAllImports);
router.post('/upload-sessions', importUploadSessionLimiter, ctrl.createUploadSessionHandler);
router.get('/upload-sessions/:sessionId', ctrl.getUploadSessionHandler);
router.get('/upload-sessions/:sessionId/parts', ctrl.listUploadSessionPartsHandler);
router.post('/upload-sessions/:sessionId/parts', importUploadSessionLimiter, ctrl.createUploadPartUrlsHandler);
router.post('/upload-sessions/:sessionId/complete', importUploadSessionLimiter, ctrl.completeUploadSessionHandler);
router.post('/upload-sessions/:sessionId/abort', ctrl.abortUploadSessionHandler);
router.post('/r2/register', ctrl.registerExistingR2ObjectHandler);
router.get('/', ctrl.listJobs);
router.post('/upload', ctrl.uploadImportFile);
router.get('/:jobId', ctrl.getJob);
router.get('/:jobId/errors', ctrl.getJobErrors);
router.post('/:jobId/start', ctrl.startJob);
router.post('/:jobId/retry', ctrl.retryJob);
router.post('/:jobId/rollback', ctrl.rollbackJob);
router.delete('/:jobId', ctrl.deleteJob);

export default router;
