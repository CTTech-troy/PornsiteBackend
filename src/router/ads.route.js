import express from 'express';
import * as ads from '../controller/ads.controller.js';
import { requireAuth } from '../middleware/authFirebase.js';

const router = express.Router();

// Public: placement-based campaign ads (Supabase)
router.get('/feed', (req, res) => { req.params.placement = 'feed'; return ads.getAdsByPlacement(req, res); });
router.get('/sidebar', (req, res) => { req.params.placement = 'sidebar'; return ads.getAdsByPlacement(req, res); });
router.get('/homepage', (req, res) => { req.params.placement = 'homepage_banner'; return ads.getAdsByPlacement(req, res); });
router.get('/placement/:placement', ads.getAdsByPlacement);
router.post('/campaign/:adId/click', ads.trackCampaignClick);

// Public: fetch next pre-roll ad (RTDB) + track events
router.get('/next', ads.getNextAd);
router.post('/:adId/impression', ads.trackImpression);
router.post('/:adId/click', ads.trackClick);

// Admin: manage RTDB ads (auth required)
router.get('/', requireAuth, ads.listAds);
router.post('/', requireAuth, ads.createAd);
router.patch('/:adId', requireAuth, ads.updateAd);
router.delete('/:adId', requireAuth, ads.deleteAd);

export default router;
