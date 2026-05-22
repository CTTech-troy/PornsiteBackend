import { Redis } from '@upstash/redis';

const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const commandTimeoutMs = readPositiveNumber('UPSTASH_REDIS_COMMAND_TIMEOUT_MS', 5000);
const retryCount = Math.floor(readPositiveNumber('UPSTASH_REDIS_RETRIES', 2));

const redisHealth = {
  provider: 'upstash',
  configured: Boolean(url && token),
  connected: false,
  lastConnectedAt: null,
  lastErrorAt: null,
  lastError: null,
};

function commandSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(commandTimeoutMs);
  }

  return undefined;
}

function sanitizeRedisError(error) {
  const message = error?.message || String(error);
  return message.split(', command was:')[0].slice(0, 300);
}

export const upstashRedis = redisHealth.configured
  ? new Redis({
      url,
      token,
      readYourWrites: true,
      enableTelemetry: false,
      // A function creates a fresh AbortSignal for each HTTP command.
      signal: commandSignal,
      retry: {
        retries: retryCount,
        backoff: (retryCount) => Math.min(1000, 50 * 2 ** retryCount),
      },
    })
  : null;

export function isRedisConfigured() {
  return redisHealth.configured;
}

export function getRedisHealth() {
  return { ...redisHealth };
}

function markRedisConnected() {
  redisHealth.connected = true;
  redisHealth.lastConnectedAt = new Date().toISOString();
  redisHealth.lastError = null;
}

export function markRedisError(error) {
  redisHealth.connected = false;
  redisHealth.lastErrorAt = new Date().toISOString();
  redisHealth.lastError = sanitizeRedisError(error);
}

export async function sendRedisCommand(...command) {
  if (!upstashRedis) {
    throw new Error('Upstash Redis is not configured');
  }

  const [nameRaw, ...args] = command;
  const name = String(nameRaw || '').toUpperCase();

  try {
    let result;

    switch (name) {
      case 'SCRIPT': {
        const subcommand = String(args[0] || '').toUpperCase();
        if (subcommand !== 'LOAD') {
          throw new Error(`Unsupported Redis SCRIPT subcommand for rate limiting: ${subcommand}`);
        }
        result = await upstashRedis.scriptLoad(args[1]);
        break;
      }

      case 'EVALSHA': {
        const [sha, keyCountRaw, ...rest] = args;
        const keyCount = Number(keyCountRaw);
        if (!Number.isInteger(keyCount) || keyCount < 0) {
          throw new Error(`Invalid Redis EVALSHA key count: ${keyCountRaw}`);
        }
        const keys = rest.slice(0, keyCount).map(String);
        const scriptArgs = rest.slice(keyCount).map(String);
        result = await upstashRedis.evalsha(sha, keys, scriptArgs);
        break;
      }

      case 'DECR':
        result = await upstashRedis.decr(args[0]);
        break;

      case 'DEL':
        result = await upstashRedis.del(...args);
        break;

      case 'PING':
        result = await upstashRedis.ping();
        break;

      default:
        throw new Error(`Unsupported Redis command for rate limiting: ${name}`);
    }

    markRedisConnected();
    return result;
  } catch (error) {
    markRedisError(error);
    throw error;
  }
}

export async function pingRedis() {
  if (!upstashRedis) {
    return {
      ...getRedisHealth(),
      connected: false,
      message: 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable shared Redis rate limits.',
    };
  }

  const started = Date.now();

  try {
    const pong = await sendRedisCommand('PING');
    return {
      ...getRedisHealth(),
      connected: pong === 'PONG',
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...getRedisHealth(),
      connected: false,
      latencyMs: Date.now() - started,
      lastError: sanitizeRedisError(error),
    };
  }
}
