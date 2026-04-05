import rateLimit from 'express-rate-limit';
import { recordAuth } from '../utils/authMetrics.js';

const jsonMessage = { success: false, message: 'Too many requests. Please wait and try again.' };

function limitHandler(req, res, _next, options) {
  recordAuth('rateLimited');
  res.status(options.statusCode).json(
    typeof options.message === 'function' ? options.message(req, res) : options.message
  );
}

if (process.env.NODE_ENV === 'production' && !(process.env.REDIS_URL || '').trim()) {
  console.warn(
    '[authRateLimit] REDIS_URL not set: limits are per-process only. Use Redis + rate-limit-redis for multi-instance (see docs/AUTH_SCALING.md).'
  );
}

function makeLimiter({ windowMs, max, burstMax, burstWindowMs }) {
  const burst = rateLimit({
    windowMs: burstWindowMs,
    max: burstMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: jsonMessage,
    handler: limitHandler,
  });
  const window = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: jsonMessage,
    handler: limitHandler,
  });
  return [burst, window];
}

const loginBurstMax = Number(process.env.AUTH_LOGIN_BURST_PER_MIN || 120);
const loginWindowMax = Number(process.env.AUTH_LOGIN_MAX_PER_15M || 800);
const signupBurstMax = Number(process.env.AUTH_SIGNUP_BURST_PER_MIN || 15);
const signupWindowMax = Number(process.env.AUTH_SIGNUP_MAX_PER_15M || 60);
const meWindowMax = Number(process.env.AUTH_ME_MAX_PER_15M || 400);

export const [authLoginBurst, authLoginWindow] = makeLimiter({
  burstWindowMs: 60 * 1000,
  burstMax: loginBurstMax,
  windowMs: 15 * 60 * 1000,
  max: loginWindowMax,
});

export const [authSignupBurst, authSignupWindow] = makeLimiter({
  burstWindowMs: 60 * 1000,
  burstMax: signupBurstMax,
  windowMs: 15 * 60 * 1000,
  max: signupWindowMax,
});

export const authMeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: meWindowMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage,
  handler: limitHandler,
});

export const authRouteLimiter = authLoginWindow;
export const authBurstLimiter = authLoginBurst;
