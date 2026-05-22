import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from './rateLimitStore.js';
import { recordAuth } from '../utils/authMetrics.js';

const jsonMessage = { success: false, message: 'Too many requests. Please wait and try again.' };

function readLimit(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function limitHandler(req, res, _next, options) {
  recordAuth('rateLimited');
  res.status(options.statusCode).json(
    typeof options.message === 'function' ? options.message(req, res) : options.message
  );
}

function makeLimiter({ name, windowMs, max, burstMax, burstWindowMs }) {
  const common = {
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    passOnStoreError: true,
    message: jsonMessage,
    handler: limitHandler,
  };

  const burst = rateLimit({
    ...common,
    windowMs: burstWindowMs,
    max: burstMax,
    store: createRateLimitStore(`auth:${name}:burst`),
  });

  const window = rateLimit({
    ...common,
    windowMs,
    max,
    store: createRateLimitStore(`auth:${name}:window`),
  });

  return [burst, window];
}

export const [authLoginBurst, authLoginWindow] = makeLimiter({
  name: 'login',
  burstWindowMs: 60 * 1000,
  burstMax: readLimit('AUTH_LOGIN_BURST_PER_MIN', 20),
  windowMs: 15 * 60 * 1000,
  max: readLimit('AUTH_LOGIN_MAX_PER_15M', 100),
});

export const [authSignupBurst, authSignupWindow] = makeLimiter({
  name: 'signup',
  burstWindowMs: 60 * 1000,
  burstMax: readLimit('AUTH_SIGNUP_BURST_PER_MIN', 5),
  windowMs: 15 * 60 * 1000,
  max: readLimit('AUTH_SIGNUP_MAX_PER_15M', 25),
});

export const [authForgotPasswordBurst, authForgotPasswordWindow] = makeLimiter({
  name: 'forgot-password',
  burstWindowMs: 60 * 1000,
  burstMax: readLimit('AUTH_FORGOT_PASSWORD_BURST_PER_MIN', 5),
  windowMs: 15 * 60 * 1000,
  max: readLimit('AUTH_FORGOT_PASSWORD_MAX_PER_15M', 15),
});

export const authMeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: readLimit('AUTH_ME_MAX_PER_15M', 400),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  passOnStoreError: true,
  store: createRateLimitStore('auth:me'),
  message: jsonMessage,
  handler: limitHandler,
});

// Backward-compatible exports used by older routes/tests.
export const authRouteLimiter = authLoginWindow;
export const authBurstLimiter = authLoginBurst;
