import { getRawRequestBody } from '../middleware/qstashSignature.js';
import {
  aggregateApiMetrics,
  detectApiIncidents,
  flushApiRequestQueue,
  generateApiSummary,
  getApiOverview,
  runMonitoringAggregationCycle,
  runScheduledHealthChecks,
} from '../services/apiMonitoring.service.js';

function readPayload(req) {
  const raw = getRawRequestBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function workflowMeta(req, type) {
  return {
    type,
    messageId: req.get('Upstash-Message-Id') || null,
    retried: Number(req.get('Upstash-Retried') || 0),
    scheduleId: req.get('Upstash-Schedule-Id') || null,
    timestamp: new Date().toISOString(),
  };
}

async function emitMonitoringSnapshot(req, range = '1h') {
  const io = req.app?.get?.('io');
  if (!io) return;
  try {
    const snapshot = await getApiOverview({ range, forceFresh: true });
    io.to('admin:api-monitoring').emit('admin:api-monitoring:update', snapshot);
  } catch (error) {
    console.warn('[api-monitor:qstash] websocket snapshot emit failed:', error?.message || error);
  }
}

export async function runMonitoringAggregateWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = payload.fullCycle === false
      ? await aggregateApiMetrics({
          rangeMinutes: Number(payload.rangeMinutes) || 10,
          bucketMinutes: Number(payload.bucketMinutes) || 1,
        })
      : await runMonitoringAggregationCycle();

    console.info('[api-monitor:qstash] aggregation workflow completed', {
      messageId: req.get('Upstash-Message-Id') || null,
      success: result.success,
    });

    await emitMonitoringSnapshot(req);
    return res.json({ success: true, workflow: workflowMeta(req, 'aggregate'), result });
  } catch (error) {
    console.error('[api-monitor:qstash] aggregation workflow failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      workflow: workflowMeta(req, 'aggregate'),
      message: 'API monitoring aggregation failed.',
    });
  }
}

export async function runMonitoringHealthWorkflow(req, res) {
  try {
    const result = await runScheduledHealthChecks();
    console.info('[api-monitor:qstash] health workflow completed', {
      messageId: req.get('Upstash-Message-Id') || null,
      checked: result.checked,
    });
    await emitMonitoringSnapshot(req);
    return res.json({ success: true, workflow: workflowMeta(req, 'health-check'), result });
  } catch (error) {
    console.error('[api-monitor:qstash] health workflow failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      workflow: workflowMeta(req, 'health-check'),
      message: 'API monitoring health checks failed.',
    });
  }
}

export async function runMonitoringIncidentWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await detectApiIncidents({ range: payload.range || '1h' });
    console.info('[api-monitor:qstash] incident workflow completed', {
      messageId: req.get('Upstash-Message-Id') || null,
      created: result.created,
      resolved: result.resolved,
    });
    await emitMonitoringSnapshot(req);
    return res.json({ success: true, workflow: workflowMeta(req, 'incident-scan'), result });
  } catch (error) {
    console.error('[api-monitor:qstash] incident workflow failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      workflow: workflowMeta(req, 'incident-scan'),
      message: 'API incident scan failed.',
    });
  }
}

export async function runMonitoringSummaryWorkflow(req, res) {
  const payload = readPayload(req);
  const period = payload.period === 'weekly' ? 'weekly' : 'daily';
  try {
    const result = await generateApiSummary({ period });
    console.info('[api-monitor:qstash] summary workflow completed', {
      messageId: req.get('Upstash-Message-Id') || null,
      period,
      rows: result.rows,
    });
    return res.json({ success: true, workflow: workflowMeta(req, `${period}-summary`), result });
  } catch (error) {
    console.error('[api-monitor:qstash] summary workflow failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      workflow: workflowMeta(req, `${period}-summary`),
      message: 'API monitoring summary failed.',
    });
  }
}

export async function flushMonitoringEventsWorkflow(req, res) {
  try {
    const result = await flushApiRequestQueue();
    return res.json({ success: true, workflow: workflowMeta(req, 'flush'), result });
  } catch (error) {
    console.error('[api-monitor:qstash] flush workflow failed:', error?.message || error);
    return res.status(500).json({
      success: false,
      workflow: workflowMeta(req, 'flush'),
      message: 'API monitoring flush failed.',
    });
  }
}

export async function handleMonitoringWorkflowFailure(req, res) {
  const payload = readPayload(req);
  console.error('[api-monitor:qstash] workflow delivery moved to failure callback', {
    messageId: req.get('Upstash-Message-Id') || null,
    retried: req.get('Upstash-Retried') || null,
    payload,
  });

  return res.json({
    success: true,
    workflow: workflowMeta(req, 'failure-callback'),
    received: true,
  });
}
