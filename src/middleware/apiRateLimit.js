import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from './rateLimitStore.js';

const generalApiMessage = {
  success: false,
  message: 'Too many API requests. Please slow down and try again shortly.',
};

function readLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readLimit('API_GENERAL_MAX_PER_MIN', 300),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('api:general'),
  message: generalApiMessage,
});
