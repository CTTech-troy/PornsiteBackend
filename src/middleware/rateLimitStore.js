import { MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { isRedisConfigured, markRedisError, sendRedisCommand } from '../config/redis.js';

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const fallbackCooldownMs = readPositiveNumber('RATE_LIMIT_REDIS_FALLBACK_COOLDOWN_MS', 30_000);
let redisUnavailableUntil = 0;

function pauseRedisTemporarily(error) {
  markRedisError(error);
  redisUnavailableUntil = Date.now() + fallbackCooldownMs;
}

class ResilientRedisStore {
  constructor(name, redisStore) {
    this.name = name;
    this.redisStore = redisStore;
    this.memoryStore = new MemoryStore();
    this.redisDisabledUntil = 0;
    this.prefix = redisStore.prefix;
  }

  init(options) {
    this.redisStore.init(options);
    this.memoryStore.init(options);
  }

  async useFallback(method, args) {
    return this.memoryStore[method](...args);
  }

  async run(method, args) {
    if (Date.now() < Math.max(this.redisDisabledUntil, redisUnavailableUntil)) {
      return this.useFallback(method, args);
    }

    try {
      return await this.redisStore[method](...args);
    } catch (error) {
      pauseRedisTemporarily(error);
      this.redisDisabledUntil = redisUnavailableUntil;
      console.warn(
        `[rateLimit:${this.name}] Redis store failed; using in-memory fallback for ${fallbackCooldownMs}ms:`,
        error?.message || error
      );
      return this.useFallback(method, args);
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
    if (typeof this.memoryStore.resetAll === 'function') {
      await this.memoryStore.resetAll();
    }
  }
}

export function createRateLimitStore(name) {
  if (!isRedisConfigured()) {
    return new MemoryStore();
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
