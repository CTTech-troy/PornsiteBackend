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

const RATE_LIMIT_BYPASS_PREFIXES = [
  '/api/imports',
  '/api/enterprise-import',
  '/api/internal',
  '/api/queue',
  '/api/admin/content/imports',
  '/api/admin/video-import',
  '/api/health/import-queue',
  '/api/health/import-worker',
];

function normalizedPath(req) {
  return String(req.originalUrl || req.url || '')
    .split('?')[0]
    .replace(/\/+$/, '')
    || '/';
}

export function isGeneralRateLimitBypass(req) {
  const path = normalizedPath(req);
  return RATE_LIMIT_BYPASS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readLimit('API_GENERAL_MAX_PER_MIN', 300),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  skip: isGeneralRateLimitBypass,
  store: createRateLimitStore('api:general', { redis: false }),
  message: generalApiMessage,
});
