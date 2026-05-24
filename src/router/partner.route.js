import { Router } from 'express';
import { requireAuth, requirePartnerAuth, requirePartnerMonetization } from '../middleware/requirePartnerAuth.js';
import * as partnerCtrl from '../controller/partner.controller.js';
import * as websiteCtrl from '../controller/partnerWebsite.controller.js';
import * as adUnitCtrl from '../controller/partnerAdUnit.controller.js';
import * as analyticsCtrl from '../controller/partnerAnalytics.controller.js';
import * as networkCtrl from '../controller/partnerNetwork.controller.js';

const router = Router();

router.post('/inquiries', partnerCtrl.postInquiry);

router.post('/register', requireAuth, partnerCtrl.postRegister);

router.use(requirePartnerAuth);

router.get('/me', partnerCtrl.getMe);
router.patch('/me', partnerCtrl.patchMe);

router.get('/websites', websiteCtrl.list);
router.post('/websites', websiteCtrl.create);
router.get('/websites/:id/verification', websiteCtrl.getVerification);
router.post('/websites/:id/verify', websiteCtrl.postVerify);

router.get('/ad-units', adUnitCtrl.list);
router.post('/ad-units', requirePartnerMonetization, adUnitCtrl.create);
router.get('/ad-units/:id/embed', requirePartnerMonetization, adUnitCtrl.getEmbed);
router.patch('/ad-units/:id', requirePartnerMonetization, adUnitCtrl.patch);

router.get('/analytics/overview', analyticsCtrl.overview);
router.get('/analytics/chart', analyticsCtrl.chart);
router.get('/referrals', analyticsCtrl.referrals);
router.get('/earnings', analyticsCtrl.earnings);
router.get('/payouts', analyticsCtrl.listPayouts);
router.post('/payouts', analyticsCtrl.requestPayout);

router.get('/network/pricing', networkCtrl.getNetworkPricingHandler);
router.get('/network/library', requirePartnerMonetization, networkCtrl.getNetworkLibrary);
router.get('/network/my-campaigns', networkCtrl.listMyNetworkCampaigns);
router.post('/network/campaigns', requirePartnerMonetization, networkCtrl.submitNetworkCampaign);

export default router;
