import { Router } from 'express';
import { keepAliveAbuseLimiter, getRawRequestBody, verifyQstashSignature } from '../middleware/qstashSignature.js';
import {
  dispatchEnterpriseImportWake,
  getEnterpriseImportQueueHealth,
  reconcileEnterpriseImportQueue,
  recordEnterpriseQueueEvent,
  wakeEnterpriseImportWorkers,
} from '../services/enterpriseImportQueue.service.js';
import { runEnterpriseImportWorkerOnce } from '../services/enterpriseImportWorker.service.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

function qstashMeta(req) {
  return {
    messageId: req.get('Upstash-Message-Id') || null,
    scheduleId: req.get('Upstash-Schedule-Id') || null,
    retried: req.get('Upstash-Retried') || req.get('Upstash-Retry-Count') || null,
    signaturePresent: Boolean(req.get('Upstash-Signature')),
  };
}

router.post('/wake', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(getRawRequestBody(req) || '{}');
    wakeEnterpriseImportWorkers(body.reason || 'qstash-wake');
    const reconcile = await reconcileEnterpriseImportQueue({ source: 'qstash-wake' });
    await recordEnterpriseQueueEvent('qstash_wake_received', {
      jobId: body.jobId || null,
      reason: body.reason || null,
      qstash: qstashMeta(req),
      reconcile,
    });
    return res.json({
      success: true,
      wake: true,
      reconcile,
      qstash: qstashMeta(req),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    await recordEnterpriseQueueEvent('qstash_wake_error', {
      error: error?.message || String(error),
      qstash: qstashMeta(req),
    }).catch(() => null);
    return res.status(500).json({ success: false, message: error?.message || 'Wake failed' });
  }
});

router.post('/process-once', async (req, res) => {
  try {
    const result = await runEnterpriseImportWorkerOnce({ workerIndex: 0 });
    return res.json({ success: true, result, qstash: qstashMeta(req), timestamp: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Worker run failed' });
  }
});

router.post('/reconcile', async (req, res) => {
  try {
    const result = await reconcileEnterpriseImportQueue({ source: 'qstash-reconcile' });
    if (result.enqueued > 0) await dispatchEnterpriseImportWake({ reason: 'qstash-reconcile' });
    return res.json({ success: true, result, qstash: qstashMeta(req), timestamp: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Reconcile failed' });
  }
});

router.post('/failure', async (req, res) => {
  await recordEnterpriseQueueEvent('qstash_delivery_failed', {
    qstash: qstashMeta(req),
    body: getRawRequestBody(req).slice(0, 2000),
  }).catch(() => null);
  return res.json({ success: true, acknowledged: true });
});

router.get('/health', async (_req, res) => {
  const health = await getEnterpriseImportQueueHealth();
  return res.status(health.redis.configured && !health.redis.connected ? 503 : 200).json({ success: true, health });
});

export default router;
