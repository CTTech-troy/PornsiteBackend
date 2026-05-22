import crypto from 'crypto';
import { recordApiRequest, normalizeApiPath } from '../services/apiMonitoring.service.js';

const IGNORED_PREFIXES = [
  '/api/admin/system/observability',
  '/api/internal/qstash/monitoring',
  '/api/keepalive/status',
];

function shouldMonitor(req) {
  const path = normalizeApiPath(req.originalUrl || req.url || '');
  if (!path.startsWith('/api')) return false;
  return !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function byteLength(chunk, encoding) {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
}

function requestSize(req) {
  const declared = Number(req.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (Buffer.isBuffer(req.body)) return req.body.length;
  if (typeof req.rawBody === 'string') return Buffer.byteLength(req.rawBody);
  return 0;
}

function responseSize(res, countedBytes) {
  const declared = Number(res.getHeader('content-length') || 0);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return countedBytes;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function requestUser(req) {
  return req.user?.id || req.user?.uid || req.userId || req.uid || null;
}

export function apiMonitoringMiddleware(req, res, next) {
  if (!shouldMonitor(req)) return next();

  const started = process.hrtime.bigint();
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  let countedResponseBytes = 0;

  res.setHeader('X-Request-Id', requestId);

  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function writeWithMonitoring(chunk, encoding, callback) {
    countedResponseBytes += byteLength(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };

  res.end = function endWithMonitoring(chunk, encoding, callback) {
    countedResponseBytes += byteLength(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };

  res.on('finish', () => {
    const latencyMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const endpoint = normalizeApiPath(req.originalUrl || req.url || '/');
    const statusCode = res.statusCode || 0;

    recordApiRequest({
      requestId,
      method: req.method,
      endpoint,
      statusCode,
      latencyMs,
      requestBytes: requestSize(req),
      responseBytes: responseSize(res, countedResponseBytes),
      ip: clientIp(req),
      userAgent: req.get('user-agent') || '',
      adminId: req.admin?.id || null,
      userId: requestUser(req),
      errorMessage: statusCode >= 400 ? res.statusMessage : null,
      timestamp: new Date().toISOString(),
    });
  });

  return next();
}
