import { randomUUID } from 'crypto';
import { supabase, isConfigured } from '../config/supabase.js';
import { getAiModerationWorkflowUrl, getQstashStatus, qstashClient } from '../config/qstash.js';
import { getRedisHealth, markRedisError, upstashRedis } from '../config/redis.js';
import { logAdminAction } from './adminAudit.service.js';

const REDIS_QUEUE_KEY = 'ai:moderation:queue';
const REDIS_ALERT_FEED_KEY = 'ai:moderation:alerts';
const REDIS_SESSION_PREFIX = 'ai:moderation:session:';
const REDIS_RISK_PREFIX = 'ai:moderation:risk:';

const DEFAULT_THRESHOLDS = {
  review: 45,
  alert: 65,
  critical: 85,
};

const MODEL_ROUTING = {
  image: 'qwen2.5-vl',
  frame: 'qwen2.5-vl',
  screenshot: 'qwen2.5-vl',
  audio: 'whisper',
  transcript: 'whisper',
  chat: 'detoxify',
  text: 'detoxify',
  object: 'yolov8',
  nudity: 'nudenet',
  behavior: 'isolation_forest',
  finance: 'isolation_forest',
};

function isMissingTable(error) {
  const msg = String(error?.message || '');
  return error?.code === '42P01' || error?.code === 'PGRST200' || error?.code === '42703' || /schema cache|does not exist/i.test(msg);
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function clampRisk(value) {
  return Math.max(0, Math.min(100, Math.round(number(value) * 100) / 100));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function severityFromRisk(score) {
  if (score >= DEFAULT_THRESHOLDS.critical) return 'critical';
  if (score >= DEFAULT_THRESHOLDS.alert) return 'high';
  if (score >= DEFAULT_THRESHOLDS.review) return 'medium';
  if (score >= 20) return 'low';
  return 'info';
}

function verdictFromRisk(score) {
  if (score >= DEFAULT_THRESHOLDS.critical) return 'escalate';
  if (score >= DEFAULT_THRESHOLDS.alert) return 'block';
  if (score >= DEFAULT_THRESHOLDS.review) return 'review';
  return 'allow';
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'unserializable' });
  }
}

async function redisSet(key, value, ttlSeconds = 3600) {
  if (!upstashRedis) return;
  try {
    await upstashRedis.set(key, value, { ex: ttlSeconds });
  } catch (error) {
    markRedisError(error);
  }
}

async function redisGet(key) {
  if (!upstashRedis) return null;
  try {
    const value = await upstashRedis.get(key);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  } catch (error) {
    markRedisError(error);
    return null;
  }
}

async function redisListLength(key) {
  if (!upstashRedis) return 0;
  try {
    return number(await upstashRedis.llen(key), 0);
  } catch (error) {
    markRedisError(error);
    return 0;
  }
}

async function pushRedisFeed(key, payload, max = 200) {
  if (!upstashRedis) return;
  try {
    await upstashRedis.lpush(key, safeJson(payload));
    await upstashRedis.ltrim(key, 0, max - 1);
  } catch (error) {
    markRedisError(error);
  }
}

async function readRedisFeed(key, limit = 25) {
  if (!upstashRedis) return [];
  try {
    const rows = await upstashRedis.lrange(key, 0, Math.max(0, limit - 1));
    return (rows || []).map((row) => {
      if (typeof row !== 'string') return row;
      try {
        return JSON.parse(row);
      } catch {
        return row;
      }
    });
  } catch (error) {
    markRedisError(error);
    return [];
  }
}

function textRisk(text = '') {
  const value = String(text || '').toLowerCase();
  const signals = [];
  let score = 0;

  const checks = [
    { re: /\b(kill yourself|kys|suicide|murder|stab|shoot|bomb|terror)\b/i, label: 'threat_or_self_harm', weight: 72 },
    { re: /\b(slur|whore|bitch|idiot|moron)\b/i, label: 'harassment_or_abuse', weight: 35 },
    { re: /\b(send money|cashapp|wire me|off platform|telegram|whatsapp)\b/i, label: 'off_platform_payment_or_grooming', weight: 58 },
    { re: /\b(chargeback|refund scam|stolen card|fake id)\b/i, label: 'payment_abuse', weight: 70 },
    { re: /(.)\1{8,}|https?:\/\/|www\./i, label: 'spam_pattern', weight: 25 },
  ];

  for (const check of checks) {
    if (check.re.test(value)) {
      signals.push(check.label);
      score = Math.max(score, check.weight);
    }
  }

  if (value.length > 1200) {
    signals.push('unusually_long_message');
    score = Math.max(score, 30);
  }

  return {
    riskScore: clampRisk(score),
    confidence: signals.length ? 74 : 35,
    labels: { signals },
    modelName: 'heuristic-detoxify-fallback',
  };
}

function metadataRisk(metadata = {}) {
  const labels = metadata.labels || metadata.detections || {};
  const riskCandidates = [
    metadata.riskScore,
    metadata.risk_score,
    metadata.nsfwScore,
    metadata.nudityScore,
    metadata.weaponScore,
    metadata.toxicity,
    labels.nsfw,
    labels.nudity,
    labels.weapon,
  ].map((value) => number(value, 0));

  const riskScore = clampRisk(Math.max(0, ...riskCandidates));
  return {
    riskScore,
    confidence: riskScore > 0 ? 70 : 30,
    labels: typeof labels === 'object' ? labels : { labels },
    modelName: metadata.modelName || metadata.model_name || 'heuristic-vision-fallback',
  };
}

function localModerationEstimate({ contentType = 'text', message = '', transcript = '', metadata = {} }) {
  const type = String(contentType || 'text').toLowerCase();
  if (['chat', 'text', 'message'].includes(type) || message || transcript) {
    return textRisk(message || transcript);
  }
  return metadataRisk(metadata);
}

function publicSession(row) {
  if (!row) return null;
  return {
    ...row,
    hiddenParticipant: {
      role: 'system_ai',
      hidden: true,
      id: row.hidden_participant_id || 'system_ai',
    },
  };
}

function publicEvent(row) {
  if (!row) return null;
  return row;
}

function emitAiModeration(io, event, payload) {
  try {
    io?.to?.('admin:ai-moderation')?.emit?.(event, payload);
  } catch (error) {
    console.warn('[ai-moderation] socket emit failed:', error?.message || error);
  }
}

async function getSessionBySessionId(sessionId) {
  if (!supabase || !sessionId) return null;
  const { data, error } = await supabase
    .from('ai_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return data;
}

export async function ensureAiSession({
  sessionId,
  sessionType = 'livestream',
  creatorId = null,
  title = null,
  metadata = {},
  io = null,
} = {}) {
  if (!sessionId || !isConfigured() || !supabase) return null;

  const row = {
    session_id: String(sessionId),
    session_type: sessionType,
    status: 'active',
    title,
    creator_id: creatorId,
    hidden_participant_id: 'system_ai',
    hidden_participant_metadata: { hidden: true, role: 'system_ai' },
    metadata: {
      ...metadata,
      aiModerator: { hidden: true, role: 'system_ai', joinedBeforeInteraction: true },
    },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('ai_sessions')
    .upsert(row, { onConflict: 'session_id' })
    .select()
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  const session = publicSession(data);
  await redisSet(`${REDIS_SESSION_PREFIX}${sessionId}`, session, 7200);
  emitAiModeration(io, 'ai:session-updated', { session });
  return session;
}

export async function endAiSession({ sessionId, status = 'ended', metadata = {}, io = null } = {}) {
  if (!sessionId || !supabase) return null;
  const { data, error } = await supabase
    .from('ai_sessions')
    .update({
      status,
      ended_at: new Date().toISOString(),
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .select()
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const session = publicSession(data);
  await redisSet(`${REDIS_SESSION_PREFIX}${sessionId}`, session, 3600);
  emitAiModeration(io, 'ai:session-updated', { session });
  return session;
}

async function updateUserBehaviorProfile({ userId, riskScore, labels = {}, eventType = '' }) {
  if (!userId || !supabase) return;
  const now = new Date().toISOString();
  const existing = await supabase
    .from('user_behavior_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing.error && isMissingTable(existing.error)) return;

  const previous = existing.data || {};
  const nextRisk = clampRisk(Math.max(number(previous.risk_score), riskScore * 0.8));
  const strikes = number(previous.strikes_count) + (riskScore >= DEFAULT_THRESHOLDS.alert ? 1 : 0);
  const features = {
    ...(previous.features || {}),
    lastEventType: eventType,
    lastLabels: labels,
  };

  await supabase.from('user_behavior_profiles').upsert({
    user_id: userId,
    risk_score: nextRisk,
    anomaly_score: clampRisk(Math.max(number(previous.anomaly_score), riskScore > 70 ? riskScore - 10 : 0)),
    events_count: number(previous.events_count) + 1,
    strikes_count: strikes,
    last_seen_at: now,
    features,
    updated_at: now,
  }, { onConflict: 'user_id' });
}

async function createAlertForEvent({ session, event, io = null }) {
  if (!supabase || !event || event.risk_score < DEFAULT_THRESHOLDS.alert) return null;
  const existing = await supabase
    .from('ai_alerts')
    .select('*')
    .eq('moderation_event_id', event.id)
    .maybeSingle();
  if (existing.data) return existing.data;
  if (existing.error && !isMissingTable(existing.error) && existing.error.code !== 'PGRST116') throw existing.error;

  const title = event.severity === 'critical'
    ? 'Critical AI moderation alert'
    : 'AI moderation alert';
  const description = event.message || event.transcript || `${event.event_type} flagged by ${event.model_name || 'AI moderator'}`;
  const { data, error } = await supabase
    .from('ai_alerts')
    .insert({
      ai_session_id: event.ai_session_id,
      moderation_event_id: event.id,
      session_id: event.session_id,
      alert_type: event.event_type,
      severity: event.severity,
      title,
      description: String(description || '').slice(0, 1000),
      risk_score: event.risk_score,
      metadata: {
        contentType: event.content_type,
        labels: event.labels,
        hiddenAiParticipant: session?.hiddenParticipant || { hidden: true, role: 'system_ai' },
      },
    })
    .select()
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  await pushRedisFeed(REDIS_ALERT_FEED_KEY, data, 200);
  emitAiModeration(io, 'ai:alert-created', { alert: data });
  return data;
}

async function maybeFlagContent({ session, event }) {
  if (!supabase || !event || event.risk_score < DEFAULT_THRESHOLDS.review) return null;
  const existing = await supabase
    .from('flagged_content')
    .select('*')
    .eq('moderation_event_id', event.id)
    .maybeSingle();
  if (existing.data) return existing.data;
  if (existing.error && !isMissingTable(existing.error) && existing.error.code !== 'PGRST116') throw existing.error;

  const contentId = event.content_id || event.content_ref || `${event.session_id}:${event.id}`;
  const row = {
    ai_session_id: session?.id || event.ai_session_id || null,
    moderation_event_id: event.id,
    content_id: contentId,
    content_type: event.content_type || 'unknown',
    user_id: event.user_id,
    snapshot_url: event.raw_payload?.snapshotUrl || null,
    storage_path: event.raw_payload?.storagePath || null,
    reason: event.message || event.transcript || event.event_type,
    labels: event.labels || {},
    risk_score: event.risk_score,
    status: 'pending',
  };
  const { data, error } = await supabase.from('flagged_content').insert(row).select().maybeSingle();
  if (error && !isMissingTable(error)) console.warn('[ai-moderation] flagged_content insert failed:', error.message || error);

  await supabase.from('ai_flags').insert({
    content_id: contentId,
    content_type: event.content_type || 'unknown',
    reason: row.reason,
    severity: event.severity,
    status: 'pending',
    metadata: { moderationEventId: event.id, sessionId: event.session_id, labels: event.labels || {} },
  }).then(() => null, () => null);

  return data || null;
}

async function updateSessionRisk({ sessionId, riskScore, io = null }) {
  if (!supabase || !sessionId) return null;
  const session = await getSessionBySessionId(sessionId);
  if (!session) return null;
  const nextRisk = clampRisk(Math.max(number(session.risk_score) * 0.65, riskScore));
  const nextMax = clampRisk(Math.max(number(session.max_risk_score), riskScore));
  const { data, error } = await supabase
    .from('ai_sessions')
    .update({
      risk_score: nextRisk,
      max_risk_score: nextMax,
      event_count: number(session.event_count) + 1,
      alert_count: number(session.alert_count) + (riskScore >= DEFAULT_THRESHOLDS.alert ? 1 : 0),
      last_event_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .select()
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const publicRow = publicSession(data);
  await redisSet(`${REDIS_RISK_PREFIX}${sessionId}`, { riskScore: nextRisk, maxRiskScore: nextMax }, 7200);
  emitAiModeration(io, 'ai:session-updated', { session: publicRow });
  return publicRow;
}

async function enqueueAiTask(task, { retries = 3, delaySeconds = 0 } = {}) {
  const url = getAiModerationWorkflowUrl('/process');
  const payload = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...task,
  };

  await pushRedisFeed(REDIS_QUEUE_KEY, payload, readPositiveInteger('AI_MODERATION_REDIS_QUEUE_MAX', 1000));

  if (!qstashClient || !url) {
    return { queued: false, redisQueued: Boolean(upstashRedis), reason: 'QStash not configured.' };
  }

  const result = await qstashClient.publishJSON({
    url,
    body: payload,
    delay: delaySeconds > 0 ? delaySeconds : undefined,
    retries,
    retryDelay: process.env.QSTASH_AI_MODERATION_RETRY_DELAY || '1000 * pow(2, retried)',
    failureCallback: getAiModerationWorkflowUrl('/failure'),
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
  });

  return { queued: true, redisQueued: Boolean(upstashRedis), ...result };
}

export async function recordModerationSignal({
  sessionId,
  sessionType = 'livestream',
  eventType = 'activity',
  source = 'system',
  userId = null,
  peerUserId = null,
  contentType = 'text',
  contentId = null,
  contentRef = null,
  message = '',
  transcript = '',
  metadata = {},
  queueAi = true,
  io = null,
} = {}) {
  if (!sessionId || !supabase) return null;
  const session = await ensureAiSession({ sessionId, sessionType, creatorId: metadata.creatorId || null, title: metadata.title || null, metadata, io });
  const estimate = localModerationEstimate({ contentType, message, transcript, metadata });
  const riskScore = clampRisk(metadata.riskScore ?? estimate.riskScore);
  const confidence = clampRisk(metadata.confidence ?? estimate.confidence);
  const labels = { ...(estimate.labels || {}), ...(metadata.labels || {}) };
  const severity = severityFromRisk(riskScore);
  const verdict = verdictFromRisk(riskScore);
  const modelName = metadata.modelName || estimate.modelName || MODEL_ROUTING[contentType] || 'ai-moderation';

  const { data, error } = await supabase
    .from('moderation_events')
    .insert({
      ai_session_id: session?.id || null,
      session_id: String(sessionId),
      session_type: sessionType,
      event_type: eventType,
      source,
      user_id: userId,
      peer_user_id: peerUserId,
      content_type: contentType,
      content_id: contentId,
      content_ref: contentRef,
      message: message ? String(message).slice(0, 4000) : null,
      transcript: transcript ? String(transcript).slice(0, 4000) : null,
      risk_score: riskScore,
      confidence,
      severity,
      verdict,
      model_name: modelName,
      labels,
      raw_payload: metadata,
    })
    .select()
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  const event = publicEvent(data);
  await updateSessionRisk({ sessionId, riskScore, io });
  await updateUserBehaviorProfile({ userId, riskScore, labels, eventType });
  await maybeFlagContent({ session, event });
  const alert = await createAlertForEvent({ session, event, io });

  await supabase.from('ai_risk_scores').insert({
    ai_session_id: session?.id || null,
    session_id: String(sessionId),
    category: contentType || 'overall',
    model_name: modelName,
    score: riskScore,
    confidence,
    metadata: labels,
  }).then(() => null, () => null);

  emitAiModeration(io, 'ai:event-created', { event, alert });

  if (queueAi) {
    await enqueueAiTask({
      taskType: contentType,
      eventId: event.id,
      sessionId,
      sessionType,
      content: { message, transcript, contentRef, contentId },
      metadata,
      modelHint: MODEL_ROUTING[contentType] || MODEL_ROUTING.text,
    }, { retries: readPositiveInteger('QSTASH_AI_MODERATION_TASK_RETRIES', 3) }).catch((err) => {
      console.warn('[ai-moderation] QStash enqueue failed:', err?.message || err);
    });
  }

  return { event, alert };
}

async function callAiService(path, task) {
  const baseUrl = String(process.env.AI_MODERATION_SERVICE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return null;

  const retries = readPositiveInteger('AI_MODERATION_SERVICE_RETRIES', 2);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), readPositiveInteger('AI_MODERATION_SERVICE_TIMEOUT_MS', 12000));
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.AI_WORKER_API_KEY ? { 'X-AI-Worker-Key': process.env.AI_WORKER_API_KEY } : {}),
        },
        body: JSON.stringify(task),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `AI service returned ${res.status}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(Math.min(1500, 150 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('AI service request failed.');
}

async function callInferenceService(task) {
  const result = await callAiService('/v1/moderate', task);
  if (!result) throw new Error('AI moderation service not configured.');
  return result;
}

async function callTrainingService(task) {
  const baseUrl = String(process.env.AI_MODERATION_SERVICE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return { queued: false, reason: 'AI moderation service not configured.' };
  return callAiService('/v1/retrain', task);
}

export async function processAiModerationTask(task = {}, { io = null } = {}) {
  if (!supabase) return { success: false, reason: 'Supabase not configured.' };
  if (task.taskType === 'training') {
    const result = await callTrainingService(task).catch((error) => ({ queued: false, error: error?.message || String(error) }));
    if (task.trainingLogId) {
      await supabase
        .from('ai_training_logs')
        .update({
          status: result.queued === false ? 'failed' : 'running',
          metrics: { service: result },
          error_message: result.error || null,
        })
        .eq('id', task.trainingLogId)
        .then(() => null, () => null);
    }
    emitAiModeration(io, 'ai:training-updated', { trainingLogId: task.trainingLogId, result });
    return { success: result.queued !== false, training: true, result };
  }

  const serviceResult = await callInferenceService(task).catch((error) => ({
    fallback: true,
    error: error?.message || String(error),
    ...localModerationEstimate({
      contentType: task.taskType,
      message: task.content?.message || '',
      transcript: task.content?.transcript || '',
      metadata: task.metadata || {},
    }),
  }));

  const riskScore = clampRisk(serviceResult?.riskScore ?? serviceResult?.risk_score ?? 0);
  const confidence = clampRisk(serviceResult?.confidence ?? 0);
  const labels = serviceResult?.labels || serviceResult?.detections || {};
  const modelName = serviceResult?.modelName || serviceResult?.model_name || task.modelHint || MODEL_ROUTING[task.taskType] || 'ai-service';

  if (task.eventId) {
    const { data: updated, error } = await supabase
      .from('moderation_events')
      .update({
        risk_score: riskScore,
        confidence,
        severity: severityFromRisk(riskScore),
        verdict: verdictFromRisk(riskScore),
        model_name: modelName,
        labels,
        raw_payload: { ...(task.metadata || {}), aiService: serviceResult },
      })
      .eq('id', task.eventId)
      .select()
      .maybeSingle();
    if (error && !isMissingTable(error)) throw error;
    if (updated) {
      const session = await updateSessionRisk({ sessionId: updated.session_id, riskScore, io });
      await maybeFlagContent({ session, event: updated });
      const alert = await createAlertForEvent({ session, event: updated, io });
      emitAiModeration(io, 'ai:event-updated', { event: updated, alert });
    }
  }

  return { success: true, riskScore, confidence, modelName, labels, serviceResult };
}

export async function recordWorkerHeartbeat(payload = {}) {
  if (!supabase) return null;
  const row = {
    worker_id: String(payload.workerId || payload.worker_id || 'ai-worker-default'),
    worker_type: payload.workerType || payload.worker_type || 'inference',
    status: payload.status || 'healthy',
    model_name: payload.modelName || payload.model_name || null,
    gpu_name: payload.gpuName || payload.gpu_name || null,
    gpu_memory_used_mb: payload.gpuMemoryUsedMb || payload.gpu_memory_used_mb || null,
    gpu_memory_total_mb: payload.gpuMemoryTotalMb || payload.gpu_memory_total_mb || null,
    queue_depth: number(payload.queueDepth || payload.queue_depth, 0),
    inference_latency_ms: number(payload.inferenceLatencyMs || payload.inference_latency_ms, 0),
    throughput_per_minute: number(payload.throughputPerMinute || payload.throughput_per_minute, 0),
    last_heartbeat_at: new Date().toISOString(),
    metadata: payload.metadata || {},
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('ai_worker_health').upsert(row, { onConflict: 'worker_id' }).select().maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return data;
}

export async function aggregateAiModeration({ rangeMinutes = 15 } = {}) {
  if (!supabase) return { success: false };
  const since = new Date(Date.now() - rangeMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('moderation_events')
    .select('session_id,risk_score,confidence,content_type,model_name,created_at')
    .gte('created_at', since)
    .limit(5000);
  if (error) {
    if (isMissingTable(error)) return { success: false, missingMigration: true };
    throw error;
  }

  const bySession = new Map();
  for (const row of data || []) {
    const key = row.session_id || 'unknown';
    const current = bySession.get(key) || { max: 0, total: 0, count: 0, models: new Set() };
    current.max = Math.max(current.max, number(row.risk_score));
    current.total += number(row.risk_score);
    current.count += 1;
    if (row.model_name) current.models.add(row.model_name);
    bySession.set(key, current);
  }

  for (const [sessionId, group] of bySession.entries()) {
    await supabase.from('ai_risk_scores').insert({
      session_id: sessionId,
      category: 'aggregate',
      model_name: Array.from(group.models).join(',') || 'aggregate',
      score: clampRisk(group.max),
      confidence: clampRisk(group.count ? group.total / group.count : 0),
      window_start: since,
      window_end: new Date().toISOString(),
      metadata: { eventCount: group.count },
    }).then(() => null, () => null);
  }

  return { success: true, sessionsAggregated: bySession.size, events: data?.length || 0 };
}

export async function escalateStaleAiAlerts({ io = null } = {}) {
  if (!supabase) return { success: false };
  const cutoff = new Date(Date.now() - readPositiveInteger('AI_ALERT_ESCALATE_AFTER_MINUTES', 20) * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ai_alerts')
    .select('*')
    .in('status', ['open', 'reviewing'])
    .is('escalated_at', null)
    .gte('risk_score', DEFAULT_THRESHOLDS.alert)
    .lt('created_at', cutoff)
    .limit(100);
  if (error) {
    if (isMissingTable(error)) return { success: false, missingMigration: true };
    throw error;
  }

  let escalated = 0;
  for (const alert of data || []) {
    const { data: updated } = await supabase
      .from('ai_alerts')
      .update({ escalated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', alert.id)
      .select()
      .maybeSingle();
    if (updated) {
      escalated += 1;
      emitAiModeration(io, 'ai:alert-escalated', { alert: updated });
    }
  }
  return { success: true, escalated };
}

export async function generateAiModerationSummary() {
  if (!supabase) return { success: false };
  const result = await aggregateAiModeration({ rangeMinutes: 24 * 60 });
  await supabase.from('ai_training_logs').insert({
    model_name: 'moderation-summary',
    status: 'completed',
    metrics: { dailySummary: result },
    completed_at: new Date().toISOString(),
  }).then(() => null, () => null);
  return { success: true, result };
}

export async function getAiModerationOverview() {
  if (!supabase) return emptyOverview();
  const [sessions, alerts, events, workers] = await Promise.all([
    supabase.from('ai_sessions').select('*').eq('status', 'active').order('started_at', { ascending: false }).limit(50),
    supabase.from('ai_alerts').select('*').in('status', ['open', 'reviewing']).order('created_at', { ascending: false }).limit(25),
    supabase.from('moderation_events').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('ai_worker_health').select('*').order('last_heartbeat_at', { ascending: false }).limit(20),
  ]);

  if ([sessions.error, alerts.error, events.error, workers.error].some((err) => err && !isMissingTable(err))) {
    throw sessions.error || alerts.error || events.error || workers.error;
  }

  const sessionRows = sessions.data || [];
  const alertRows = alerts.data || [];
  const eventRows = events.data || [];
  const workerRows = workers.data || [];
  const criticalAlerts = alertRows.filter((alert) => ['high', 'critical'].includes(alert.severity)).length;
  const avgRisk = sessionRows.length
    ? sessionRows.reduce((sum, row) => sum + number(row.risk_score), 0) / sessionRows.length
    : 0;

  return {
    stats: {
      activeSessions: sessionRows.length,
      flaggedSessions: sessionRows.filter((row) => number(row.max_risk_score) >= DEFAULT_THRESHOLDS.alert).length,
      realtimeAlerts: alertRows.length,
      criticalAlerts,
      eventsLastHour: eventRows.filter((row) => new Date(row.created_at).getTime() >= Date.now() - 3600_000).length,
      avgRiskScore: clampRisk(avgRisk),
    },
    aiHealth: buildAiHealth(workerRows),
    sessions: sessionRows.map(publicSession),
    alerts: alertRows,
    feed: eventRows,
    redis: {
      ...getRedisHealth(),
      queueDepth: await redisListLength(REDIS_QUEUE_KEY),
      alertFeedDepth: await redisListLength(REDIS_ALERT_FEED_KEY),
    },
    qstash: getQstashStatus(),
  };
}

function emptyOverview() {
  return {
    stats: { activeSessions: 0, flaggedSessions: 0, realtimeAlerts: 0, criticalAlerts: 0, eventsLastHour: 0, avgRiskScore: 0 },
    aiHealth: { status: 'unknown', workersOnline: 0, avgLatencyMs: 0 },
    sessions: [],
    alerts: [],
    feed: [],
    redis: getRedisHealth(),
    qstash: getQstashStatus(),
  };
}

function buildAiHealth(workers = []) {
  const now = Date.now();
  const online = workers.filter((worker) => {
    const last = new Date(worker.last_heartbeat_at || 0).getTime();
    return worker.status === 'healthy' && Number.isFinite(last) && now - last < 90_000;
  });
  const avgLatency = online.length
    ? online.reduce((sum, worker) => sum + number(worker.inference_latency_ms), 0) / online.length
    : 0;
  return {
    status: online.length ? 'healthy' : workers.length ? 'degraded' : 'offline',
    workersOnline: online.length,
    workersTotal: workers.length,
    avgLatencyMs: Math.round(avgLatency),
  };
}

export async function getAiLiveMonitoring() {
  const overview = await getAiModerationOverview();
  return {
    sessions: overview.sessions,
    alerts: overview.alerts,
    feed: overview.feed,
  };
}

export async function getAiIncidents({ page = 1, limit = 25, status = '', severity = '', search = '' } = {}) {
  if (!supabase) return { incidents: [], total: 0, page, limit };
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (p - 1) * l;

  let countQ = supabase.from('ai_alerts').select('*', { count: 'exact', head: true });
  if (status) countQ = countQ.eq('status', status);
  if (severity) countQ = countQ.eq('severity', severity);
  if (search) countQ = countQ.or(`session_id.ilike.%${search}%,title.ilike.%${search}%,description.ilike.%${search}%`);
  const { count, error: countError } = await countQ;
  if (countError) {
    if (isMissingTable(countError)) return { incidents: [], total: 0, page: p, limit: l };
    throw countError;
  }

  let q = supabase.from('ai_alerts').select('*');
  if (status) q = q.eq('status', status);
  if (severity) q = q.eq('severity', severity);
  if (search) q = q.or(`session_id.ilike.%${search}%,title.ilike.%${search}%,description.ilike.%${search}%`);
  q = q.order('created_at', { ascending: false }).range(offset, offset + l - 1);
  const { data, error } = await q;
  if (error) throw error;
  return { incidents: data || [], total: count || 0, page: p, limit: l };
}

export async function getAiAnalytics({ range = '24h' } = {}) {
  if (!supabase) return { timeline: [], byType: [], confidence: [], heatmap: [] };
  const hours = range === '7d' ? 24 * 7 : range === '30d' ? 24 * 30 : range === '6h' ? 6 : 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await supabase
    .from('moderation_events')
    .select('created_at,content_type,risk_score,confidence,severity,verdict')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(10000);
  if (error) {
    if (isMissingTable(error)) return { timeline: [], byType: [], confidence: [], heatmap: [] };
    throw error;
  }

  const timeline = new Map();
  const byType = new Map();
  const heatmap = new Map();
  for (const row of data || []) {
    const date = new Date(row.created_at);
    const bucket = range === '24h' || range === '6h'
      ? date.toISOString().slice(0, 13) + ':00'
      : date.toISOString().slice(0, 10);
    const t = timeline.get(bucket) || { ts: bucket, events: 0, avgRisk: 0, critical: 0 };
    t.events += 1;
    t.avgRisk += number(row.risk_score);
    if (['high', 'critical'].includes(row.severity)) t.critical += 1;
    timeline.set(bucket, t);

    const type = row.content_type || 'unknown';
    const bt = byType.get(type) || { type, events: 0, avgRisk: 0 };
    bt.events += 1;
    bt.avgRisk += number(row.risk_score);
    byType.set(type, bt);

    const heatKey = `${date.getDay()}-${date.getHours()}`;
    heatmap.set(heatKey, (heatmap.get(heatKey) || 0) + 1);
  }

  return {
    timeline: Array.from(timeline.values()).map((row) => ({ ...row, avgRisk: row.events ? Math.round(row.avgRisk / row.events) : 0 })),
    byType: Array.from(byType.values()).map((row) => ({ ...row, avgRisk: row.events ? Math.round(row.avgRisk / row.events) : 0 })),
    confidence: (data || []).slice(-100).map((row) => ({ ts: row.created_at, confidence: number(row.confidence), risk: number(row.risk_score) })),
    heatmap: Array.from(heatmap.entries()).map(([key, count]) => {
      const [day, hour] = key.split('-').map(Number);
      return { day, hour, count };
    }),
  };
}

export async function getAiFraudDetection() {
  if (!supabase) return { logs: [], suspiciousPayouts: [], profiles: [] };
  const [logs, payouts, profiles] = await Promise.all([
    supabase.from('fraud_detection_logs').select('*').order('created_at', { ascending: false }).limit(50),
    supabase.from('creator_payout_requests').select('id,creator_id,creator_name,amount_usd,status,risk_score,risk_flags,requested_at').gte('risk_score', 50).order('requested_at', { ascending: false }).limit(30),
    supabase.from('user_behavior_profiles').select('*').gte('risk_score', 50).order('risk_score', { ascending: false }).limit(30),
  ]);
  return {
    logs: logs.error && isMissingTable(logs.error) ? [] : logs.data || [],
    suspiciousPayouts: payouts.error && isMissingTable(payouts.error) ? [] : payouts.data || [],
    profiles: profiles.error && isMissingTable(profiles.error) ? [] : profiles.data || [],
  };
}

export async function getAiTrainingCenter() {
  if (!supabase) return { rules: [], trainingLogs: [] };
  const [rules, logs] = await Promise.all([
    supabase.from('ai_moderation_rules').select('*').order('category').order('rule_key'),
    supabase.from('ai_training_logs').select('*').order('created_at', { ascending: false }).limit(50),
  ]);
  return {
    rules: rules.error && isMissingTable(rules.error) ? [] : rules.data || [],
    trainingLogs: logs.error && isMissingTable(logs.error) ? [] : logs.data || [],
  };
}

export async function getAiInfrastructure() {
  if (!supabase) return { workers: [], redis: getRedisHealth(), qstash: getQstashStatus(), queues: {} };
  const { data, error } = await supabase.from('ai_worker_health').select('*').order('last_heartbeat_at', { ascending: false }).limit(100);
  if (error && !isMissingTable(error)) throw error;
  const serviceHealth = await pingAiService();
  return {
    workers: data || [],
    serviceHealth,
    aiHealth: buildAiHealth(data || []),
    redis: getRedisHealth(),
    qstash: getQstashStatus(),
    queues: {
      moderation: await redisListLength(REDIS_QUEUE_KEY),
      alerts: await redisListLength(REDIS_ALERT_FEED_KEY),
    },
    recentAlertFeed: await readRedisFeed(REDIS_ALERT_FEED_KEY, 20),
  };
}

async function pingAiService() {
  const baseUrl = String(process.env.AI_MODERATION_SERVICE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return { configured: false, status: 'not_configured' };
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers: process.env.AI_WORKER_API_KEY ? { 'X-AI-Worker-Key': process.env.AI_WORKER_API_KEY } : {},
      signal: AbortSignal.timeout?.(5000),
    });
    const data = await res.json().catch(() => ({}));
    return { configured: true, ok: res.ok, status: res.ok ? 'healthy' : 'degraded', latencyMs: Date.now() - started, ...data };
  } catch (error) {
    return { configured: true, ok: false, status: 'offline', latencyMs: Date.now() - started, error: error?.message || String(error) };
  }
}

export async function getAiSessionDetail(sessionId) {
  if (!supabase) return null;
  const [session, events, alerts, scores] = await Promise.all([
    supabase.from('ai_sessions').select('*').eq('session_id', sessionId).maybeSingle(),
    supabase.from('moderation_events').select('*').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(200),
    supabase.from('ai_alerts').select('*').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(100),
    supabase.from('ai_risk_scores').select('*').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(300),
  ]);
  if (session.error) {
    if (isMissingTable(session.error)) return null;
    throw session.error;
  }
  if (!session.data) return null;
  return {
    session: publicSession(session.data),
    events: events.error && isMissingTable(events.error) ? [] : events.data || [],
    alerts: alerts.error && isMissingTable(alerts.error) ? [] : alerts.data || [],
    scores: scores.error && isMissingTable(scores.error) ? [] : scores.data || [],
  };
}

export async function reviewAiAlert({ alertId, status, action = 'reviewed', notes = '', admin = {}, req = null, io = null }) {
  if (!supabase) throw new Error('Database not configured.');
  const allowed = ['acknowledged', 'reviewing', 'resolved', 'dismissed'];
  if (!allowed.includes(status)) throw new Error('Invalid alert status.');
  const now = new Date().toISOString();
  const update = {
    status,
    updated_at: now,
    resolution_note: notes || null,
  };
  if (status === 'acknowledged') update.acknowledged_at = now;
  if (status === 'resolved' || status === 'dismissed') update.resolved_at = now;
  const { data, error } = await supabase.from('ai_alerts').update(update).eq('id', alertId).select().maybeSingle();
  if (error) throw error;
  await supabase.from('moderation_reviews').insert({
    alert_id: alertId,
    reviewer_id: admin?.id || null,
    reviewer_name: admin?.name || admin?.email || 'Admin',
    status,
    action,
    notes,
  }).then(() => null, () => null);
  await logAdminAction(req || { admin }, {
    admin,
    action: `AI moderation alert ${status}`,
    targetType: 'ai_alert',
    targetId: alertId,
    details: { action, notes },
  });
  emitAiModeration(io, 'ai:alert-updated', { alert: data });
  return data;
}

export async function updateAiModerationRule({ ruleKey, value, enabled, admin = {}, req = null }) {
  if (!supabase) throw new Error('Database not configured.');
  const update = {
    value,
    enabled: enabled !== undefined ? Boolean(enabled) : true,
    updated_by: admin?.id || admin?.email || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('ai_moderation_rules')
    .update(update)
    .eq('rule_key', ruleKey)
    .select()
    .maybeSingle();
  if (error) throw error;
  await logAdminAction(req || { admin }, {
    admin,
    action: 'Updated AI moderation rule',
    targetType: 'ai_moderation_rule',
    targetId: ruleKey,
    details: { value, enabled },
  });
  return data;
}

export async function triggerAiTraining({ datasetName, modelName, thresholdConfig = {}, admin = {}, req = null }) {
  if (!supabase) throw new Error('Database not configured.');
  const { data, error } = await supabase
    .from('ai_training_logs')
    .insert({
      initiated_by: admin?.id || admin?.email || null,
      dataset_name: datasetName,
      model_name: modelName || 'moderation-ensemble',
      status: 'queued',
      threshold_config: thresholdConfig,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  await enqueueAiTask({
    taskType: 'training',
    trainingLogId: data.id,
    datasetName,
    modelName,
    thresholdConfig,
  }, { retries: readPositiveInteger('QSTASH_AI_TRAINING_RETRIES', 2), delaySeconds: 5 });
  await logAdminAction(req || { admin }, {
    admin,
    action: 'Queued AI moderation retraining',
    targetType: 'ai_training_log',
    targetId: data.id,
    details: { datasetName, modelName },
  });
  return data;
}
