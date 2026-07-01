import { Router } from 'express';
import { requireAdminAuth, requireFinanceAccess } from '../middleware/adminAuth.js';
import {
  getPublicAdConfigHandler,
  postAdMonitoringEvent,
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
  getPublicSafeAdPolicyHandler,
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

function adsManagedInCode(_req, res) {
  return res.status(410).json({
    success: false,
    code: 'ADS_MANAGED_IN_CODE',
    message: 'Ad configuration is managed manually in the codebase and cannot be changed from the admin panel.',
  });
}

adminRouter.get('/providers', adsManagedInCode);
adminRouter.patch('/providers/:id', adsManagedInCode);
adminRouter.put('/providers/priority', adsManagedInCode);
adminRouter.post('/zones', adsManagedInCode);
adminRouter.delete('/zones/:id', adsManagedInCode);
adminRouter.get('/monitoring', getAdminMonitoringOverview);
adminRouter.get('/monitoring/sessions/:sessionId', getAdminSessionTimeline);
adminRouter.get('/analytics', getAdminAnalytics);
adminRouter.post('/health/scan', postAdminHealthScan);
adminRouter.get('/health/history', getAdminHealthHistory);
adminRouter.get('/health/juicy-diagnostics', getAdminJuicyDiagnostics);
adminRouter.post('/health/probe-vast', postAdminProbeVast);
adminRouter.post('/health/fallback', postAdminFallback);
adminRouter.get('/audit', getAdminAuditLog);
adminRouter.get('/slots', adsManagedInCode);
adminRouter.post('/slots', adsManagedInCode);
adminRouter.patch('/slots/:slotKey', adsManagedInCode);
adminRouter.delete('/slots/:slotKey', adsManagedInCode);
adminRouter.put('/juicyads/settings', adsManagedInCode);
adminRouter.get('/safe-settings', adsManagedInCode);
adminRouter.put('/safe-settings', adsManagedInCode);

router.use('/admin', adminRouter);

export default router;
