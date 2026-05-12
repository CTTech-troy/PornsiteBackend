import express from 'express';
import * as adminCtrl from '../controller/admin.controller.js';
import * as adminSystem from '../controller/adminSystem.controller.js';
import * as adminUsers from '../controller/adminUsers.controller.js';
import { adminContentRouter } from './adminContent.route.js';
import { adminModerationRouter } from './adminModeration.route.js';

const router = express.Router();

// --- Admin Auth ---
router.post('/signup', adminCtrl.signupAdmin);
router.post('/activate', adminCtrl.activateAdmin);
router.post('/login', adminCtrl.loginAdmin);
router.post('/invite', adminCtrl.inviteAdmin);
router.get('/invite/verify', adminCtrl.verifyInviteToken);
router.post('/invite/complete', adminCtrl.completeInvite);

// --- Admin Management ---
router.get('/admins', adminCtrl.listAdminUsers);
router.delete('/admins/:id', adminCtrl.deleteAdminUser);
router.patch('/admins/:id/permissions', adminCtrl.updateUserPermissions);
router.patch('/admins/:id/toggle', adminCtrl.toggleAdminUser);

// --- User & Creator Management ---
router.get('/users', adminUsers.getUsers);
router.get('/users/:id', adminUsers.getUserById);
router.patch('/users/:id/status', adminUsers.updateUserStatus);
router.patch('/users/:id/coins', adminUsers.updateUserCoins);

router.get('/creators', adminUsers.getPlatformCreators);
router.patch('/creators/:id/status', adminUsers.updateCreatorStatus);
router.get('/applications', adminUsers.getCreatorApplications);
router.get('/applications/:id', adminUsers.getApplicationById);
router.patch('/applications/:id/status', adminUsers.updateApplicationStatus);

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
router.use('/moderation', adminModerationRouter);

export default router;
