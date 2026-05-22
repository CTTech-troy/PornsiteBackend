import rateLimit from 'express-rate-limit';
import {
  getQstashVerificationUrl,
  isQstashReceiverConfigured,
  qstashReceiver,
} from '../config/qstash.js';

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const keepAliveAbuseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readPositiveInteger('QSTASH_KEEPALIVE_MAX_PER_MIN', 30),
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many keep-alive requests.',
  },
});

export function getRawRequestBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return JSON.stringify(req.body);
  }
  return '';
}

export async function verifyQstashSignature(req, res, next) {
  const signature = req.get('Upstash-Signature');

  if (!signature) {
    console.warn('[keepalive] rejected request without QStash signature', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(401).json({ success: false, message: 'Missing QStash signature.' });
  }

  if (!isQstashReceiverConfigured()) {
    console.error('[keepalive] QStash signing keys are not configured.');
    return res.status(503).json({ success: false, message: 'Keep-alive verification is not configured.' });
  }

  try {
    const body = getRawRequestBody(req);
    const url = getQstashVerificationUrl(req);
    const isValid = await qstashReceiver.verify({
      signature,
      body,
      url,
      upstashRegion: req.get('Upstash-Region') || undefined,
      clockTolerance: readPositiveInteger('QSTASH_CLOCK_TOLERANCE_SECONDS', 60),
    });

    if (!isValid) {
      console.warn('[keepalive] invalid QStash signature', {
        ip: req.ip,
        path: req.originalUrl,
        messageId: req.get('Upstash-Message-Id') || null,
      });
      return res.status(401).json({ success: false, message: 'Invalid QStash signature.' });
    }

    return next();
  } catch (error) {
    console.warn('[keepalive] QStash signature verification failed', {
      ip: req.ip,
      path: req.originalUrl,
      error: error?.message || String(error),
    });
    return res.status(401).json({ success: false, message: 'Invalid QStash signature.' });
  }
}
