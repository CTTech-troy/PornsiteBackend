import rateLimit from 'express-rate-limit';

/** In-memory limits; behind multiple app instances use rate-limit-redis (or similar) with the same key prefix. */
const jsonMessage = { success: false, message: 'Too many requests. Please wait and try again.' };

export const authRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX_PER_15M || 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage,
});

export const authBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AUTH_BURST_RATE_LIMIT_MAX_PER_MIN || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage,
});
