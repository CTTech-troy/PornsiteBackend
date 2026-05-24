import { Router } from 'express';
import * as ctrl from '../controller/adminVideoImport.controller.js';

const router = Router();

router.get('/analytics', ctrl.getAnalytics);
router.get('/events', ctrl.importEventsStream);
router.get('/', ctrl.listJobs);
router.post('/', ctrl.createJob);
router.post('/upload', ctrl.uploadImportFile);
router.get('/:jobId', ctrl.getJob);
router.get('/:jobId/errors', ctrl.getJobErrors);
router.post('/:jobId/start', ctrl.startJob);
router.post('/:jobId/retry', ctrl.retryJob);
router.post('/:jobId/rollback', ctrl.rollbackJob);

export default router;
