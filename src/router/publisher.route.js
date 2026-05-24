import { Router } from 'express';
import * as serveCtrl from '../controller/publisherServe.controller.js';

const router = Router();

router.get('/serve/:token', serveCtrl.serveHtml);
router.get('/serve/:token/image', serveCtrl.serveImage);
router.get('/serve/:token.js', serveCtrl.serveJs);
router.get('/click/:token', serveCtrl.clickRedirect);
router.get('/r/:partnerCode', serveCtrl.referralRedirect);

router.post('/track/impression', serveCtrl.trackImpression);
router.post('/track/click', serveCtrl.trackClick);

export default router;
