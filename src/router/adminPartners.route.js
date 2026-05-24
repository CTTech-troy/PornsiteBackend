import { Router } from 'express';
import { requireAdminAuth, requireFinanceAccess } from '../middleware/adminAuth.js';
import * as adminPartnersCtrl from '../controller/adminPartners.controller.js';
import { adminApproveWebsite } from '../controller/partnerWebsite.controller.js';

const router = Router();

router.use(requireAdminAuth);
router.use(requireFinanceAccess);

router.get('/overview', adminPartnersCtrl.overview);
router.get('/partners', adminPartnersCtrl.listPartners);
router.post('/partners/:id/approve', adminPartnersCtrl.approvePartnerHandler);
router.post('/partners/:id/suspend', adminPartnersCtrl.suspendPartner);
router.post('/partners/:id/fraud-rescore', adminPartnersCtrl.fraudRescore);

router.get('/websites', adminPartnersCtrl.listWebsites);
router.post('/websites/:id/approve', adminApproveWebsite);
router.post('/websites/:id/rescan', adminPartnersCtrl.rescanWebsite);

router.get('/payouts', adminPartnersCtrl.listPayouts);
router.patch('/payouts/:id', adminPartnersCtrl.updatePayoutStatus);

export default router;
