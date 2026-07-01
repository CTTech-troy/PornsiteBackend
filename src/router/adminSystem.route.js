import { Router } from 'express';
import multer from 'multer';
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
  testVastTag,
} from '../controller/adminSystem.controller.js';
import { subscribePlatformActivityEvents } from '../services/platformActivity.service.js';
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
import {
  archiveAdminLegalPolicy,
  compareAdminLegalPolicyVersions,
  createAdminLegalPolicy,
  deleteAdminLegalPolicy,
  getAdminLegalPolicy,
  listAdminLegalPolicies,
  publishAdminLegalPolicy,
  restoreAdminLegalPolicyVersion,
  updateAdminLegalPolicy,
} from '../controller/legalDocument.controller.js';
import {
  archiveAdminBlogPostEntry,
  createAdminBlogPostEntry,
  deleteAdminBlogPostEntry,
  getAdminBlogPostEntry,
  listAdminBlogPostEntries,
  publishAdminBlogPostEntry,
  updateAdminBlogPostEntry,
  uploadAdminBlogPostImage,
} from '../controller/blogPost.controller.js';

const router = Router();
router.use(requireAdminAuth);

const blogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1, Number(process.env.BLOG_IMAGE_MAX_MB || 8) || 8) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype || '')) return cb(null, true);
    return cb(new Error('Blog images must be JPG, PNG, WebP, or GIF files.'));
  },
});

function handleBlogImageUpload(req, res, next) {
  blogImageUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, message: err.message || 'Image upload failed.' });
  });
}

function requireTermsPolicyPermission(req, res, next) {
  if (req.admin?.is_super_admin || req.admin?.isSuperAdmin) return next();
  const permissions = Array.isArray(req.admin?.permissions) ? req.admin.permissions : [];
  const hasPermission = permissions.some((permission) => (
    permission === '*' ||
    permission === 'terms_policy' ||
    permission === '/terms-policy' ||
    permission?.key === 'terms_policy' ||
    permission?.path === '/terms-policy'
  ));
  if (hasPermission) return next();
  return res.status(403).json({ success: false, message: 'Terms & Policy permission is required.' });
}

function requireBlogPermission(req, res, next) {
  if (req.admin?.is_super_admin || req.admin?.isSuperAdmin) return next();
  const permissions = Array.isArray(req.admin?.permissions) ? req.admin.permissions : [];
  const hasPermission = permissions.some((permission) => (
    permission === '*' ||
    permission === 'blog' ||
    permission === 'blog_manager' ||
    permission === '/blog' ||
    permission?.key === 'blog' ||
    permission?.path === '/blog'
  ));
  if (hasPermission) return next();
  return res.status(403).json({ success: false, message: 'Blog permission is required.' });
}

router.get('/stats', getStats);
router.get('/platform-activity', getPlatformActivity);
router.get('/platform-activity/events', subscribePlatformActivityEvents);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.put('/settings/:key', updateSetting);
router.post('/vast/test', testVastTag);

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

router.get('/legal-policies', requireTermsPolicyPermission, listAdminLegalPolicies);
router.post('/legal-policies', requireTermsPolicyPermission, createAdminLegalPolicy);
router.get('/legal-policies/:id', requireTermsPolicyPermission, getAdminLegalPolicy);
router.put('/legal-policies/:id', requireTermsPolicyPermission, updateAdminLegalPolicy);
router.post('/legal-policies/:id/publish', requireTermsPolicyPermission, publishAdminLegalPolicy);
router.post('/legal-policies/:id/archive', requireTermsPolicyPermission, archiveAdminLegalPolicy);
router.delete('/legal-policies/:id', requireSuperAdmin, deleteAdminLegalPolicy);
router.post('/legal-policies/:id/versions/:versionId/restore', requireTermsPolicyPermission, restoreAdminLegalPolicyVersion);
router.get('/legal-policies/:id/versions/compare', requireTermsPolicyPermission, compareAdminLegalPolicyVersions);

router.get('/blog-posts', requireBlogPermission, listAdminBlogPostEntries);
router.post('/blog-posts/media', requireBlogPermission, handleBlogImageUpload, uploadAdminBlogPostImage);
router.post('/blog-posts', requireBlogPermission, createAdminBlogPostEntry);
router.get('/blog-posts/:id', requireBlogPermission, getAdminBlogPostEntry);
router.put('/blog-posts/:id', requireBlogPermission, updateAdminBlogPostEntry);
router.post('/blog-posts/:id/publish', requireBlogPermission, publishAdminBlogPostEntry);
router.post('/blog-posts/:id/archive', requireBlogPermission, archiveAdminBlogPostEntry);
router.delete('/blog-posts/:id', requireSuperAdmin, deleteAdminBlogPostEntry);

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
