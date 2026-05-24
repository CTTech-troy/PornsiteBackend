import express from 'express';
import * as adminCtrl from '../controller/admin.controller.js';
import * as adminSystem from '../controller/adminSystem.controller.js';
import * as adminUsers from '../controller/adminUsers.controller.js';
import { createFounderAdmin } from '../controller/adminFounder.controller.js';
import { attachAdminFromBearerToken, requireAdminAuth } from '../middleware/adminAuth.js';
import { adminDeleteUserLimiter } from '../middleware/adminRateLimit.js';
import adminContentRouter from './adminContent.route.js';
import adminVideoImportRouter from './adminVideoImport.route.js';
import adminModerationRouter from './adminModeration.route.js';
import contentRemovalRouter from './ContentRemoval.route.js';
import adminSearchRouter from './adminSearch.route.js';
import adminCreatorLeaderboardRouter from './adminCreatorLeaderboard.route.js';

const router = express.Router();

// --- Admin Auth ---
router.post('/signup', adminCtrl.signupAdmin);
router.post('/auth/signup', adminCtrl.signupAdmin);
router.post('/activate', adminCtrl.activateAdmin);
router.post('/auth/activate', adminCtrl.activateAdmin);
router.post('/login', adminCtrl.loginAdmin);
router.post('/auth/login', adminCtrl.loginAdmin);
router.post('/auth/logout', attachAdminFromBearerToken, adminCtrl.logoutAdmin);
router.post('/founder-create', createFounderAdmin);
router.post('/auth/founder-create', createFounderAdmin);
router.get('/invite/verify/:token', adminCtrl.verifyInviteToken);
router.post('/invite/complete', adminCtrl.completeInvite);
router.get('/application-update/:token', adminUsers.getApplicationByToken);
router.post('/application-update/:token', adminUsers.updateApplicationByToken);

router.use(requireAdminAuth);

router.post('/invite', adminCtrl.inviteAdmin);

// --- Admin Management ---
router.get('/admins', adminCtrl.listAdminUsers);
router.delete('/admins/:id', adminCtrl.deleteAdminUser);
router.patch('/admins/:id/permissions', adminCtrl.updateUserPermissions);
router.patch('/admins/:id/toggle', adminSystem.toggleAdminUser);
router.get('/admin-users', adminCtrl.listAdminUsers);
router.delete('/admin-users/:id', adminCtrl.deleteAdminUser);
router.patch('/admin-users/:id/permissions', adminCtrl.updateUserPermissions);
router.put('/admin-users/:id/toggle', adminSystem.toggleAdminUser);

// --- User & Creator Management ---
router.get('/users', adminUsers.getUsers);
router.get('/users/:id', adminUsers.getUserById);
router.delete('/users/:id', adminDeleteUserLimiter, adminUsers.deleteUser);
router.patch('/users/:id/status', adminUsers.updateUserStatus);
router.put('/users/:id/status', adminUsers.updateUserStatus);
router.patch('/users/:id/coins', adminUsers.updateUserCoins);
router.put('/users/:id/coins', adminUsers.updateUserCoins);

router.get('/creators', adminUsers.getPlatformCreators);
router.patch('/creators/:id/status', adminUsers.updateCreatorStatus);
router.put('/creators/:id/status', adminUsers.updateCreatorStatus);
router.get('/applications', adminUsers.getCreatorApplications);
router.get('/applications/:id', adminUsers.getApplicationById);
router.patch('/applications/:id/status', adminUsers.updateApplicationStatus);
router.put('/applications/:id/status', adminUsers.updateApplicationStatus);
router.post('/applications/:id/remove-access', adminUsers.removeCreatorAccess);
router.delete('/applications/:id', adminUsers.deleteCreatorApplication);

// --- System & Stats ---
router.get('/system/settings', adminSystem.getSettings);
router.put('/system/settings', adminSystem.updateSettings);
router.patch('/system/settings/:key', adminSystem.updateSetting);
router.get('/system/health', adminSystem.getSystemHealth);
router.get('/system/env', adminSystem.getEnvOverview);
router.get('/system/stats', adminSystem.getStats);
router.get('/system/api-health', adminSystem.getApiHealth);
router.get('/system/latency', adminSystem.getRouteLatency);

// --- Sub-routers ---
router.use('/content', adminContentRouter);
router.use('/content/imports', adminVideoImportRouter);
router.use('/content-removal', contentRemovalRouter);
router.use('/moderation', adminModerationRouter);
router.use('/search', adminSearchRouter);
router.use('/creator-leaderboard', adminCreatorLeaderboardRouter);

export default router;
