import { getRawRequestBody } from '../middleware/qstashSignature.js';
import {
  aggregateAiModeration,
  ensureAiSession,
  endAiSession,
  escalateStaleAiAlerts,
  generateAiModerationSummary,
  getAiAnalytics,
  getAiFraudDetection,
  getAiIncidents,
  getAiInfrastructure,
  getAiLiveMonitoring,
  getAiModerationOverview,
  getAiSessionDetail,
  getAiTrainingCenter,
  processAiModerationTask,
  recordModerationSignal,
  recordWorkerHeartbeat,
  reviewAiAlert,
  triggerAiTraining,
  updateAiModerationRule,
} from '../services/aiModeration.service.js';

function readPayload(req) {
  const raw = getRawRequestBody(req);
  if (!raw) return req.body || {};
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
    timestamp: new Date().toISOString(),
  };
}

export async function getAiOverviewAdmin(_req, res) {
  try {
    return res.json(await getAiModerationOverview());
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI overview.' });
  }
}

export async function getAiLiveMonitoringAdmin(_req, res) {
  try {
    return res.json(await getAiLiveMonitoring());
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load live monitoring.' });
  }
}

export async function getAiIncidentsAdmin(req, res) {
  try {
    return res.json(await getAiIncidents(req.query));
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI incidents.' });
  }
}

export async function getAiAnalyticsAdmin(req, res) {
  try {
    return res.json(await getAiAnalytics({ range: req.query.range || '24h' }));
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI analytics.' });
  }
}

export async function getAiFraudAdmin(_req, res) {
  try {
    return res.json(await getAiFraudDetection());
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI fraud detection.' });
  }
}

export async function getAiTrainingAdmin(_req, res) {
  try {
    return res.json(await getAiTrainingCenter());
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI training center.' });
  }
}

export async function getAiInfrastructureAdmin(_req, res) {
  try {
    return res.json(await getAiInfrastructure());
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI infrastructure.' });
  }
}

export async function getAiSessionDetailAdmin(req, res) {
  try {
    const detail = await getAiSessionDetail(req.params.sessionId);
    if (!detail) return res.status(404).json({ message: 'AI moderation session not found.' });
    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ message: error?.message || 'Could not load AI session.' });
  }
}

export async function reviewAiAlertAdmin(req, res) {
  try {
    const alert = await reviewAiAlert({
      alertId: req.params.id,
      status: req.body?.status,
      action: req.body?.action || 'reviewed',
      notes: req.body?.notes || '',
      admin: req.admin,
      req,
      io: req.app?.get('io'),
    });
    return res.json({ message: 'AI alert updated.', alert });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not update alert.' });
  }
}

export async function updateAiRuleAdmin(req, res) {
  try {
    const rule = await updateAiModerationRule({
      ruleKey: req.params.ruleKey,
      value: req.body?.value || {},
      enabled: req.body?.enabled,
      admin: req.admin,
      req,
    });
    return res.json({ message: 'AI moderation rule updated.', rule });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not update rule.' });
  }
}

export async function triggerAiTrainingAdmin(req, res) {
  try {
    const log = await triggerAiTraining({
      datasetName: req.body?.datasetName || 'moderation-review-dataset',
      modelName: req.body?.modelName || 'moderation-ensemble',
      thresholdConfig: req.body?.thresholdConfig || {},
      admin: req.admin,
      req,
    });
    return res.status(202).json({ message: 'AI retraining queued.', log });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not queue retraining.' });
  }
}

export async function createAiSessionAdmin(req, res) {
  try {
    const session = await ensureAiSession({
      sessionId: req.body?.sessionId,
      sessionType: req.body?.sessionType || 'system',
      creatorId: req.body?.creatorId || null,
      title: req.body?.title || null,
      metadata: req.body?.metadata || {},
      io: req.app?.get('io'),
    });
    return res.status(201).json({ session });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not create AI session.' });
  }
}

export async function endAiSessionAdmin(req, res) {
  try {
    const session = await endAiSession({
      sessionId: req.params.sessionId,
      status: req.body?.status || 'ended',
      metadata: req.body?.metadata || {},
      io: req.app?.get('io'),
    });
    return res.json({ session });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not end AI session.' });
  }
}

export async function ingestAiModerationSignal(req, res) {
  try {
    const workerKey = process.env.AI_WORKER_API_KEY;
    if (!workerKey) return res.status(503).json({ message: 'AI worker key is not configured.' });
    if (req.get('X-AI-Worker-Key') !== workerKey) {
      return res.status(401).json({ message: 'Invalid AI worker key.' });
    }
    const result = await recordModerationSignal({
      ...req.body,
      source: req.body?.source || 'ai_worker',
      io: req.app?.get('io'),
    });
    return res.status(202).json({ accepted: true, ...result });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not ingest AI moderation signal.' });
  }
}

export async function workerHeartbeat(req, res) {
  try {
    const workerKey = process.env.AI_WORKER_API_KEY;
    if (!workerKey) return res.status(503).json({ message: 'AI worker key is not configured.' });
    if (req.get('X-AI-Worker-Key') !== workerKey) {
      return res.status(401).json({ message: 'Invalid AI worker key.' });
    }
    const health = await recordWorkerHeartbeat(req.body || {});
    return res.json({ ok: true, health });
  } catch (error) {
    return res.status(400).json({ message: error?.message || 'Could not record worker heartbeat.' });
  }
}

export async function processAiModerationWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await processAiModerationTask(payload, { io: req.app?.get('io') });
    return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.process'), result });
  } catch (error) {
    console.error('[ai-moderation:qstash] process failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'ai_moderation.process'), message: error?.message || 'AI task failed.' });
  }
}

export async function aggregateAiModerationWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await aggregateAiModeration({ rangeMinutes: Number(payload.rangeMinutes || 15) });
    return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.aggregate'), result });
  } catch (error) {
    console.error('[ai-moderation:qstash] aggregate failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'ai_moderation.aggregate'), message: error?.message || 'Aggregation failed.' });
  }
}

export async function escalateAiModerationWorkflow(req, res) {
  try {
    const result = await escalateStaleAiAlerts({ io: req.app?.get('io') });
    return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.escalate'), result });
  } catch (error) {
    console.error('[ai-moderation:qstash] escalation failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'ai_moderation.escalate'), message: error?.message || 'Escalation failed.' });
  }
}

export async function summarizeAiModerationWorkflow(req, res) {
  try {
    const result = await generateAiModerationSummary();
    return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.summary'), result });
  } catch (error) {
    console.error('[ai-moderation:qstash] summary failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'ai_moderation.summary'), message: error?.message || 'Summary failed.' });
  }
}

export async function trainAiModerationWorkflow(req, res) {
  const payload = readPayload(req);
  try {
    const result = await processAiModerationTask({ ...payload, taskType: 'training' }, { io: req.app?.get('io') });
    return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.training'), result });
  } catch (error) {
    console.error('[ai-moderation:qstash] training failed:', error?.message || error);
    return res.status(500).json({ success: false, workflow: workflowMeta(req, 'ai_moderation.training'), message: error?.message || 'Training workflow failed.' });
  }
}

export async function aiModerationWorkflowFailure(req, res) {
  const payload = readPayload(req);
  console.error('[ai-moderation:qstash] workflow delivery failed', {
    messageId: req.get('Upstash-Message-Id') || null,
    retried: req.get('Upstash-Retried') || null,
    payload,
  });
  return res.json({ success: true, workflow: workflowMeta(req, 'ai_moderation.failure'), received: true });
}
