import { getQstashStatus } from '../config/qstash.js';
import { getRawRequestBody } from '../middleware/qstashSignature.js';

const keepAliveState = {
  startedAt: new Date().toISOString(),
  totalPings: 0,
  totalFailures: 0,
  lastPingAt: null,
  lastFailureAt: null,
  lastMessageId: null,
  lastScheduleId: null,
};

function qstashMeta(req) {
  return {
    messageId: req.get('Upstash-Message-Id') || null,
    scheduleId: req.get('Upstash-Schedule-Id') || null,
    retryCount: req.get('Upstash-Retried') || req.get('Upstash-Retry-Count') || null,
    signaturePresent: Boolean(req.get('Upstash-Signature')),
  };
}

function parseOptionalJsonBody(req) {
  const raw = getRawRequestBody(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

function summarizeFailurePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    status: payload.status ?? payload.statusCode ?? null,
    messageId: payload.messageId ?? payload.dlqId ?? null,
    url: payload.url ?? payload.destination ?? null,
    error: payload.error ?? payload.errorMessage ?? payload.responseBody ?? null,
  };
}

export async function handleKeepAlive(req, res) {
  try {
    const meta = qstashMeta(req);
    keepAliveState.totalPings += 1;
    keepAliveState.lastPingAt = new Date().toISOString();
    keepAliveState.lastMessageId = meta.messageId;
    keepAliveState.lastScheduleId = meta.scheduleId;

    console.info('[keepalive] Render backend ping accepted', {
      at: keepAliveState.lastPingAt,
      messageId: meta.messageId,
      scheduleId: meta.scheduleId,
      retryCount: meta.retryCount,
      uptimeSeconds: Math.round(process.uptime()),
    });

    return res.status(200).json({
      success: true,
      status: 'awake',
      timestamp: keepAliveState.lastPingAt,
      uptimeSeconds: Math.round(process.uptime()),
      qstash: meta,
    });
  } catch (error) {
    console.error('[keepalive] unexpected handler error', error?.message || error);
    return res.status(500).json({
      success: false,
      message: 'Keep-alive handler failed.',
    });
  }
}

export async function handleKeepAliveFailure(req, res) {
  const meta = qstashMeta(req);
  const payload = parseOptionalJsonBody(req);
  keepAliveState.totalFailures += 1;
  keepAliveState.lastFailureAt = new Date().toISOString();

  console.error('[keepalive] QStash reported an exhausted delivery', {
    at: keepAliveState.lastFailureAt,
    messageId: meta.messageId,
    scheduleId: meta.scheduleId,
    failure: summarizeFailurePayload(payload),
  });

  // Acknowledge the failure callback so QStash does not keep retrying the
  // monitoring notification itself.
  return res.status(200).json({
    success: true,
    received: true,
    timestamp: keepAliveState.lastFailureAt,
  });
}

export function getKeepAliveStatus(_req, res) {
  return res.status(200).json({
    success: true,
    keepAlive: {
      ...keepAliveState,
      qstash: getQstashStatus(),
    },
  });
}
