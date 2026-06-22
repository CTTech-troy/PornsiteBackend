import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { optionalAuth } from '../middleware/authFirebase.js';
import { createRateLimitStore } from '../middleware/rateLimitStore.js';
import {
  postEngagement,
  postHeartbeat,
  postPageView,
  postSessionEnd,
  postVideoWatch,
  postVisit,
} from '../controller/analytics.controller.js';

const router = Router();

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ANALYTICS_EVENTS_MAX_PER_MIN || 240),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('analytics:events'),
  message: { success: false, message: 'Too many analytics events.' },
});

router.use(optionalAuth);
router.use(analyticsLimiter);

router.post('/visit', postVisit);
router.post('/page-view', postPageView);
router.post('/heartbeat', postHeartbeat);
router.post('/session-end', postSessionEnd);
router.post('/video-watch', postVideoWatch);
router.post('/engagement', postEngagement);

export default router;
