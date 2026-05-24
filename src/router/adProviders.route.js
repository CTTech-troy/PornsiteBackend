import { Router } from 'express';
import { requireAdminAuth, requireFinanceAccess } from '../middleware/adminAuth.js';
import {
  getPublicAdConfigHandler,
  postAdMonitoringEvent,
  getAdminProviders,
  patchAdminProvider,
  putAdminPriorityOrder,
  postAdminZone,
  deleteAdminZone,
  getAdminMonitoringOverview,
  getAdminSessionTimeline,
  getAdminAnalytics,
  postAdminHealthScan,
  getAdminHealthHistory,
  getAdminJuicyDiagnostics,
  postAdminProbeVast,
  postAdminFallback,
  getAdminAuditLog,
  getPublicSlotsConfigHandler,
  getAdminSlots,
  postAdminSlot,
  patchAdminSlot,
  deleteAdminSlot,
  saveJuicyAdsSettings,
  getPublicSafeAdPolicyHandler,
  getAdminSafeAdSettings,
  saveAdminSafeAdSettings,
} from '../controller/adProvider.controller.js';

const router = Router();

const PUBLIC_ROUTE_REGISTRY = [
  'GET /api/ad-providers/config',
  'GET /api/ad-providers/safe-policy',
  'GET /api/ad-providers/slots/config',
  'POST /api/ad-providers/monitoring/events',
];

console.info('[adProvidersRouter] registered public routes', PUBLIC_ROUTE_REGISTRY);

router.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.AD_PROVIDER_ROUTE_DEBUG === 'true' || res.statusCode >= 400) {
      console.info('[adProvidersRouter] request handled', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        latencyMs: Date.now() - started,
      });
    }
  });
  next();
});

router.get('/config', getPublicAdConfigHandler);
router.get('/safe-policy', getPublicSafeAdPolicyHandler);
router.get('/slots/config', getPublicSlotsConfigHandler);
router.post('/monitoring/events', postAdMonitoringEvent);

const adminRouter = Router();
adminRouter.use(requireAdminAuth);
adminRouter.use(requireFinanceAccess);

adminRouter.get('/providers', getAdminProviders);
adminRouter.patch('/providers/:id', patchAdminProvider);
adminRouter.put('/providers/priority', putAdminPriorityOrder);
adminRouter.post('/zones', postAdminZone);
adminRouter.delete('/zones/:id', deleteAdminZone);
adminRouter.get('/monitoring', getAdminMonitoringOverview);
adminRouter.get('/monitoring/sessions/:sessionId', getAdminSessionTimeline);
adminRouter.get('/analytics', getAdminAnalytics);
adminRouter.post('/health/scan', postAdminHealthScan);
adminRouter.get('/health/history', getAdminHealthHistory);
adminRouter.get('/health/juicy-diagnostics', getAdminJuicyDiagnostics);
adminRouter.post('/health/probe-vast', postAdminProbeVast);
adminRouter.post('/health/fallback', postAdminFallback);
adminRouter.get('/audit', getAdminAuditLog);
adminRouter.get('/slots', getAdminSlots);
adminRouter.post('/slots', postAdminSlot);
adminRouter.patch('/slots/:slotKey', patchAdminSlot);
adminRouter.delete('/slots/:slotKey', deleteAdminSlot);
adminRouter.put('/juicyads/settings', saveJuicyAdsSettings);
adminRouter.get('/safe-settings', getAdminSafeAdSettings);
adminRouter.put('/safe-settings', saveAdminSafeAdSettings);

router.use('/admin', adminRouter);

export default router;
