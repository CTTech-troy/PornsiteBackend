import { Redis } from '@upstash/redis';

const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const commandTimeoutMs = readPositiveNumber('UPSTASH_REDIS_COMMAND_TIMEOUT_MS', 5000);
const retryCount = Math.floor(readPositiveNumber('UPSTASH_REDIS_RETRIES', 2));
const slowCommandMs = readPositiveNumber('UPSTASH_REDIS_SLOW_COMMAND_MS', 750);
const diagnosticsMaxRecent = Math.max(10, Math.floor(readPositiveNumber('UPSTASH_REDIS_DIAGNOSTICS_RECENT', 50)));

const redisHealth = {
  provider: 'upstash',
  configured: Boolean(url && token),
  connected: false,
  lastConnectedAt: null,
  lastErrorAt: null,
  lastError: null,
};

const redisDiagnostics = {
  startedAt: new Date().toISOString(),
  total: 0,
  success: 0,
  failure: 0,
  timeout: 0,
  slow: 0,
  byCommand: new Map(),
  recentSlow: [],
  recentErrors: [],
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

function isRedisTimeout(error) {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError' || /abort|timeout|timed out/i.test(message);
}

function rememberRecent(list, entry) {
  list.unshift(entry);
  if (list.length > diagnosticsMaxRecent) list.length = diagnosticsMaxRecent;
}

function recordRedisTiming(command, startedAt, error = null, { logSlow = true } = {}) {
  const name = String(command || 'UNKNOWN').toUpperCase();
  const durationMs = Date.now() - startedAt;
  redisDiagnostics.total += 1;
  if (error) redisDiagnostics.failure += 1;
  else redisDiagnostics.success += 1;
  if (isRedisTimeout(error)) redisDiagnostics.timeout += 1;
  if (durationMs >= slowCommandMs) {
    redisDiagnostics.slow += 1;
    rememberRecent(redisDiagnostics.recentSlow, {
      command: name,
      durationMs,
      at: new Date().toISOString(),
      error: error ? sanitizeRedisError(error) : null,
    });
    if (logSlow) {
      console.warn('[redis] slow operation', { command: name, durationMs, error: error ? sanitizeRedisError(error) : null });
    }
  }

  const stats = redisDiagnostics.byCommand.get(name) || {
    command: name,
    total: 0,
    success: 0,
    failure: 0,
    timeout: 0,
    slow: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastLatencyMs: 0,
    lastError: null,
    lastSeenAt: null,
  };
  stats.total += 1;
  if (error) stats.failure += 1;
  else stats.success += 1;
  if (isRedisTimeout(error)) stats.timeout += 1;
  if (durationMs >= slowCommandMs) stats.slow += 1;
  stats.totalLatencyMs += durationMs;
  stats.maxLatencyMs = Math.max(stats.maxLatencyMs, durationMs);
  stats.lastLatencyMs = durationMs;
  stats.lastError = error ? sanitizeRedisError(error) : null;
  stats.lastSeenAt = new Date().toISOString();
  redisDiagnostics.byCommand.set(name, stats);

  if (error) {
    rememberRecent(redisDiagnostics.recentErrors, {
      command: name,
      durationMs,
      at: new Date().toISOString(),
      error: sanitizeRedisError(error),
    });
  }
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

export function getRedisDiagnostics() {
  const byCommand = Array.from(redisDiagnostics.byCommand.values())
    .map((stats) => ({
      ...stats,
      avgLatencyMs: stats.total ? Math.round(stats.totalLatencyMs / stats.total) : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);

  return {
    startedAt: redisDiagnostics.startedAt,
    total: redisDiagnostics.total,
    success: redisDiagnostics.success,
    failure: redisDiagnostics.failure,
    timeout: redisDiagnostics.timeout,
    slow: redisDiagnostics.slow,
    slowCommandMs,
    commandTimeoutMs,
    byCommand,
    recentSlow: redisDiagnostics.recentSlow,
    recentErrors: redisDiagnostics.recentErrors,
  };
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
  const started = Date.now();

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
    recordRedisTiming(name, started);
    return result;
  } catch (error) {
    markRedisError(error);
    recordRedisTiming(name, started, error);
    throw error;
  }
}

export async function runRedisOperation(name, operation, {
  timeoutMs = commandTimeoutMs,
  critical = false,
  logSlow = true,
} = {}) {
  if (!upstashRedis) {
    const error = new Error('Upstash Redis is not configured');
    if (critical) throw error;
    return null;
  }

  let timer = null;
  const started = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Redis operation ${name} timed out after ${timeoutMs}ms`);
          error.code = 'REDIS_OPERATION_TIMEOUT';
          reject(error);
        }, Math.max(1, Number(timeoutMs) || commandTimeoutMs));
        timer.unref?.();
      }),
    ]);
    markRedisConnected();
    recordRedisTiming(name, started, null, { logSlow });
    return result;
  } catch (error) {
    markRedisError(error);
    recordRedisTiming(name, started, error, { logSlow });
    if (critical) throw error;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
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
