import { Router } from 'express';
import { requireAdminAuth, requireSuperAdmin } from '../middleware/adminAuth.js';
import {
  getSettings,
  updateSettings,
  updateSetting,
  getSystemHealth,
  getEnvOverview,
  getAdminUsers,
  toggleAdminUser,
  getStats,
  getApiHealth,
  getRouteLatency,
  getPlatformActivity,
} from '../controller/adminSystem.controller.js';
import {
  getAdminEmailTemplate,
  listAdminEmailTemplates,
  previewAdminEmailTemplate,
  previewAdminMessageEmail,
  saveAdminEmailTemplate,
  sendAdminEmailTemplateTest,
} from '../controller/adminEmailTemplates.controller.js';
import {
  getExternalFeedConfig,
  updateExternalFeedConfig,
  testExternalFeedConfig,
  getExternalFeedMeta,
} from '../controller/adminExternalFeed.controller.js';
import {
  getObservedApiDetail,
  getObservedApis,
  getObservedRequestLogs,
  getObservabilityOverview,
  getObservabilityState,
  runObservabilityAggregation,
  runObservabilityHealthChecks,
  runObservabilityIncidentScan,
  runObservabilitySummary,
} from '../controller/apiObservability.controller.js';

const router = Router();
router.use(requireAdminAuth);

router.get('/stats', getStats);
router.get('/platform-activity', getPlatformActivity);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.put('/settings/:key', updateSetting);

router.get('/health', getSystemHealth);
router.get('/api-health', getApiHealth);
router.get('/route-latency', getRouteLatency);
router.get('/env', getEnvOverview);

router.get('/email-templates', listAdminEmailTemplates);
router.get('/email-templates/:key', getAdminEmailTemplate);
router.post('/email-templates/:key/preview', previewAdminEmailTemplate);
router.post('/email-templates/preview-message', previewAdminMessageEmail);
router.post('/email-templates/:key/test-send', sendAdminEmailTemplateTest);
router.put('/email-templates/:key', saveAdminEmailTemplate);

router.get('/observability/overview', getObservabilityOverview);
router.get('/observability/apis', getObservedApis);
router.get('/observability/apis/:routeKey', getObservedApiDetail);
router.get('/observability/logs', getObservedRequestLogs);
router.get('/observability/state', getObservabilityState);
router.post('/observability/aggregate', runObservabilityAggregation);
router.post('/observability/health-checks', runObservabilityHealthChecks);
router.post('/observability/incidents', runObservabilityIncidentScan);
router.post('/observability/summary', runObservabilitySummary);

router.get('/external-feed', getExternalFeedConfig);
router.put('/external-feed', updateExternalFeedConfig);
router.post('/external-feed/test', testExternalFeedConfig);
router.get('/external-feed/meta', getExternalFeedMeta);

router.get('/admin-users', getAdminUsers);
router.put('/admin-users/:id/toggle', toggleAdminUser);

export default router;
