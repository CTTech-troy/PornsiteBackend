import { Router } from 'express';
import {
  getPlacementAd,
  getNextAd,
  getSlotAd,
  trackCampaignImpression,
  trackCampaignClick,
  trackSlotImpression,
  trackSlotClick,
} from '../controller/ads.controller.js';

const router = Router();

router.get('/next', getNextAd);
router.get('/placement/:placement', getPlacementAd);
router.get('/slot/:slotKey', getSlotAd);
router.post('/campaign/:adId/impression', trackCampaignImpression);
router.post('/campaign/:adId/click', trackCampaignClick);
router.post('/:adId/impression', trackCampaignImpression);
router.post('/:adId/click', trackCampaignClick);
router.post('/slot/:slotKey/impression', trackSlotImpression);
router.post('/slot/:slotKey/click', trackSlotClick);

router.get('/feed', (req, res) => res.redirect(302, '/api/ads/placement/feed'));
router.get('/sidebar', (req, res) => res.redirect(302, '/api/ads/placement/sidebar'));
router.get('/homepage', (req, res) => res.redirect(302, '/api/ads/placement/homepage_banner'));

export default router;
