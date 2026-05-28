import { MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { isRedisConfigured, markRedisError, sendRedisCommand } from '../config/redis.js';

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const fallbackCooldownMs = readPositiveNumber('RATE_LIMIT_REDIS_FALLBACK_COOLDOWN_MS', 30_000);
const rateLimitRedisTimeoutMs = readPositiveNumber('RATE_LIMIT_REDIS_TIMEOUT_MS', 1000);
const logCooldownMs = readPositiveNumber('RATE_LIMIT_REDIS_LOG_COOLDOWN_MS', 30_000);
let redisUnavailableUntil = 0;
let lastFallbackLogAt = 0;
const rateLimitDiagnostics = new Map();

function recordRateLimit(name, field) {
  const id = String(name || 'unknown');
  const stats = rateLimitDiagnostics.get(id) || {
    name: id,
    total: 0,
    redis: 0,
    memory: 0,
    fallback: 0,
    errors: 0,
    lastSeenAt: null,
    lastError: null,
  };
  stats.total += 1;
  stats[field] = Number(stats[field] || 0) + 1;
  stats.lastSeenAt = new Date().toISOString();
  rateLimitDiagnostics.set(id, stats);
}

function recordRateLimitError(name, error) {
  const id = String(name || 'unknown');
  const stats = rateLimitDiagnostics.get(id) || {
    name: id,
    total: 0,
    redis: 0,
    memory: 0,
    fallback: 0,
    errors: 0,
    lastSeenAt: null,
    lastError: null,
  };
  stats.errors += 1;
  stats.lastError = error?.message || String(error);
  stats.lastSeenAt = new Date().toISOString();
  rateLimitDiagnostics.set(id, stats);
}

class TrackedMemoryStore extends MemoryStore {
  constructor(name) {
    super();
    this.name = name;
  }

  async increment(key) {
    recordRateLimit(this.name, 'memory');
    return super.increment(key);
  }
}

function pauseRedisTemporarily(error) {
  markRedisError(error);
  redisUnavailableUntil = Date.now() + fallbackCooldownMs;
}

function isProductionRuntime() {
  return String(process.env.NODE_ENV || process.env.APP_ENV || '').toLowerCase() === 'production';
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function shouldUseRedisForRateLimits(options = {}) {
  if (options.redis === false) return false;
  if (!isRedisConfigured()) return false;
  if (process.env.RATE_LIMIT_REDIS_ENABLED != null) return envFlag('RATE_LIMIT_REDIS_ENABLED', true);
  if (!isProductionRuntime() && !envFlag('RATE_LIMIT_REDIS_IN_DEV', false)) return false;
  return true;
}

function maybeLogFallback(name, error) {
  const now = Date.now();
  if (now - lastFallbackLogAt < logCooldownMs) return;
  lastFallbackLogAt = now;
  console.warn(
    `[rateLimit:${name}] Redis store failed; using process-local limiter for ${fallbackCooldownMs}ms:`,
    error?.message || error
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.code = 'RATE_LIMIT_REDIS_TIMEOUT';
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ResilientRedisStore {
  constructor(name, redisStore) {
    this.name = name;
    this.redisStore = redisStore;
    this.memoryStore = new TrackedMemoryStore(`${name}:fallback`);
    this.redisDisabledUntil = 0;
    this.lastRedisError = null;
    this.prefix = redisStore.prefix;
  }

  init(options) {
    this.redisStore.init(options);
    this.memoryStore.init(options);
  }

  async local(method, args) {
    return this.memoryStore[method](...args);
  }

  async run(method, args) {
    if (Date.now() < Math.max(this.redisDisabledUntil, redisUnavailableUntil)) {
      recordRateLimit(this.name, 'fallback');
      return this.local(method, args);
    }

    try {
      const result = await withTimeout(
        this.redisStore[method](...args),
        rateLimitRedisTimeoutMs,
        `rate-limit Redis ${this.name}.${method}`,
      );
      recordRateLimit(this.name, 'redis');
      return result;
    } catch (error) {
      pauseRedisTemporarily(error);
      this.redisDisabledUntil = redisUnavailableUntil;
      this.lastRedisError = error?.message || String(error);
      recordRateLimitError(this.name, error);
      recordRateLimit(this.name, 'fallback');
      maybeLogFallback(this.name, error);
      return this.local(method, args);
    }
  }

  async increment(key) {
    return this.run('increment', [key]);
  }

  async decrement(key) {
    return this.run('decrement', [key]);
  }

  async resetKey(key) {
    return this.run('resetKey', [key]);
  }

  async get(key) {
    return this.run('get', [key]);
  }

  async resetAll() {
    await this.memoryStore.resetAll?.();
    await this.redisStore.resetAll?.().catch?.(() => undefined);
  }
}

export function createRateLimitStore(name, options = {}) {
  if (!shouldUseRedisForRateLimits(options)) {
    if (options.redis !== false && !isRedisConfigured()) {
      console.warn(`[rateLimit:${name}] Upstash Redis is not configured; using MemoryStore.`);
    }
    return new TrackedMemoryStore(name);
  }

  const prefixRoot = (process.env.RATE_LIMIT_REDIS_PREFIX || 'xstream:rl').replace(/:+$/, '');
  const redisStore = new RedisStore({
    sendCommand: (...command) => sendRedisCommand(...command),
    prefix: `${prefixRoot}:${name}:`,
  });

  // rate-limit-redis loads Lua scripts at construction time; attach handlers so
  // transient startup/network failures never become unhandled rejections.
  redisStore.incrementScriptSha?.catch((error) => pauseRedisTemporarily(error));
  redisStore.getScriptSha?.catch((error) => pauseRedisTemporarily(error));

  return new ResilientRedisStore(name, redisStore);
}

export function getRateLimitStoreDiagnostics() {
  return Array.from(rateLimitDiagnostics.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);
}
