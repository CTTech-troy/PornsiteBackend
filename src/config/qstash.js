import { Client, Receiver } from '@upstash/qstash';

const qstashToken = (process.env.QSTASH_TOKEN || '').trim();
const currentSigningKey = (process.env.QSTASH_CURRENT_SIGNING_KEY || '').trim();
const nextSigningKey = (process.env.QSTASH_NEXT_SIGNING_KEY || '').trim();
const renderBackendUrl = (process.env.RENDER_BACKEND_URL || '').trim();

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export const qstashClient = qstashToken
  ? new Client({
      token: qstashToken,
      enableTelemetry: false,
      retry: {
        retries: readPositiveInteger('QSTASH_CLIENT_RETRIES', 2),
        backoff: (retryCount) => Math.min(1000, 100 * 2 ** retryCount),
      },
    })
  : null;

export const qstashReceiver = currentSigningKey && nextSigningKey
  ? new Receiver({
      currentSigningKey,
      nextSigningKey,
    })
  : null;

export function isQstashClientConfigured() {
  return Boolean(qstashClient);
}

export function isQstashReceiverConfigured() {
  return Boolean(qstashReceiver);
}

export function getQstashStatus() {
  return {
    configured: isQstashClientConfigured() && isQstashReceiverConfigured() && Boolean(renderBackendUrl),
    clientConfigured: isQstashClientConfigured(),
    receiverConfigured: isQstashReceiverConfigured(),
    renderBackendUrlConfigured: Boolean(renderBackendUrl),
    keepAliveCron: process.env.QSTASH_KEEPALIVE_CRON || '*/10 * * * *',
    monitoringAggregationCron: process.env.QSTASH_MONITORING_AGGREGATE_CRON || '* * * * *',
    monitoringHealthCron: process.env.QSTASH_MONITORING_HEALTH_CRON || '*/5 * * * *',
    monitoringDailySummaryCron: process.env.QSTASH_MONITORING_DAILY_SUMMARY_CRON || '5 0 * * *',
    monitoringWeeklySummaryCron: process.env.QSTASH_MONITORING_WEEKLY_SUMMARY_CRON || '15 0 * * 1',
    aiModerationAggregateCron: process.env.QSTASH_AI_MODERATION_AGGREGATE_CRON || '*/5 * * * *',
    aiModerationSummaryCron: process.env.QSTASH_AI_MODERATION_SUMMARY_CRON || '20 0 * * *',
    aiModerationEscalationCron: process.env.QSTASH_AI_MODERATION_ESCALATION_CRON || '*/10 * * * *',
    monetizationExpirationCron: process.env.QSTASH_MONETIZATION_EXPIRATION_CRON || '*/15 * * * *',
    monetizationReminderCron: process.env.QSTASH_MONETIZATION_REMINDER_CRON || '0 */6 * * *',
    monetizationAnalyticsCron: process.env.QSTASH_MONETIZATION_ANALYTICS_CRON || '10 * * * *',
    paymentIntentExpirationCron: process.env.QSTASH_PAYMENT_INTENT_EXPIRATION_CRON || '*/10 * * * *',
    paymentReconciliationCron: process.env.QSTASH_PAYMENT_RECONCILIATION_CRON || '*/30 * * * *',
    paymentFraudAnalysisCron: process.env.QSTASH_PAYMENT_FRAUD_ANALYSIS_CRON || '*/15 * * * *',
  };
}

export function getPublicBackendUrl() {
  return normalizeBaseUrl(renderBackendUrl);
}

export function getKeepAliveUrl(path = '') {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) return '';
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${baseUrl}/api/keepalive${suffix === '/' ? '' : suffix}`;
}

export function getMonitoringWorkflowUrl(path = '') {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) return '';
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${baseUrl}/api/internal/qstash/monitoring${suffix === '/' ? '' : suffix}`;
}

export function getPayoutWorkflowUrl(path = '') {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) return '';
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${baseUrl}/api/internal/qstash/payouts${suffix === '/' ? '' : suffix}`;
}

export function getAiModerationWorkflowUrl(path = '') {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) return '';
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${baseUrl}/api/internal/qstash/ai-moderation${suffix === '/' ? '' : suffix}`;
}

export function getMonetizationWorkflowUrl(path = '') {
  const baseUrl = getPublicBackendUrl();
  if (!baseUrl) return '';
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${baseUrl}/api/internal/qstash/monetization${suffix === '/' ? '' : suffix}`;
}

export function getQstashVerificationUrl(req) {
  const baseUrl = getPublicBackendUrl();
  const originalUrl = req?.originalUrl || req?.url || '';
  if (baseUrl) return `${baseUrl}${originalUrl}`;

  // Local fallback for non-production tests. Production should always set
  // RENDER_BACKEND_URL so QStash verifies the public Render URL exactly.
  const host = req?.get?.('host') || '';
  const protocol = req?.protocol || 'http';
  return host ? `${protocol}://${host}${originalUrl}` : '';
}

export function buildKeepAliveScheduleRequest() {
  const destination = getKeepAliveUrl();
  if (!destination) {
    throw new Error('RENDER_BACKEND_URL is required to create the QStash keep-alive schedule.');
  }

  const failureCallback = getKeepAliveUrl('/failure');
  const scheduleId = (process.env.QSTASH_KEEPALIVE_SCHEDULE_ID || 'render-backend-keepalive').trim();
  const cron = process.env.QSTASH_KEEPALIVE_CRON || '*/10 * * * *';
  const retries = readPositiveInteger('QSTASH_KEEPALIVE_RETRIES', 3);
  const timeout = readPositiveInteger('QSTASH_KEEPALIVE_TIMEOUT_SECONDS', 15);

  return {
    destination,
    cron,
    scheduleId,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Keepalive-Source': 'upstash-qstash',
    },
    body: JSON.stringify({
      type: 'render.keepalive',
      target: 'backend',
    }),
    retries,
    // Small exponential backoff keeps transient Render cold-start/network
    // failures from immediately exhausting all attempts.
    retryDelay: '1000 * pow(2, retried)',
    timeout,
    failureCallback,
    label: process.env.QSTASH_KEEPALIVE_LABEL || 'render-keepalive',
  };
}

export async function createKeepAliveSchedule() {
  if (!qstashClient) {
    throw new Error('QSTASH_TOKEN is required to create a QStash schedule.');
  }

  const request = buildKeepAliveScheduleRequest();
  const result = await qstashClient.schedules.create(request);

  return {
    ...result,
    destination: request.destination,
    failureCallback: request.failureCallback,
    cron: request.cron,
    retries: request.retries,
    timeout: request.timeout,
    scheduleId: result.scheduleId || request.scheduleId,
  };
}

function buildMonitoringSchedule({
  key,
  path,
  cron,
  body,
  timeoutSeconds = 25,
  retries = 3,
}) {
  const destination = getMonitoringWorkflowUrl(path);
  if (!destination) {
    throw new Error('RENDER_BACKEND_URL is required to create QStash monitoring schedules.');
  }

  return {
    destination,
    cron,
    scheduleId: (process.env[`QSTASH_MONITORING_${key}_SCHEDULE_ID`] || `api-monitoring-${key.toLowerCase()}`).trim(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
    body: JSON.stringify(body),
    retries,
    retryDelay: process.env.QSTASH_MONITORING_RETRY_DELAY || '1000 * pow(2, retried)',
    timeout: timeoutSeconds,
    failureCallback: getMonitoringWorkflowUrl('/failure'),
    label: process.env.QSTASH_MONITORING_LABEL || 'api-observability',
  };
}

export function buildMonitoringWorkflowSchedules() {
  const retries = readPositiveInteger('QSTASH_MONITORING_RETRIES', 3);
  return [
    buildMonitoringSchedule({
      key: 'AGGREGATE',
      path: '/aggregate',
      cron: process.env.QSTASH_MONITORING_AGGREGATE_CRON || '* * * * *',
      body: {
        type: 'api.monitoring.aggregate',
        fullCycle: false,
        rangeMinutes: readPositiveInteger('API_MONITOR_AGGREGATION_RANGE_MINUTES', 10),
        bucketMinutes: 1,
      },
      timeoutSeconds: readPositiveInteger('QSTASH_MONITORING_AGGREGATE_TIMEOUT_SECONDS', 25),
      retries,
    }),
    buildMonitoringSchedule({
      key: 'HEALTH',
      path: '/health-check',
      cron: process.env.QSTASH_MONITORING_HEALTH_CRON || '*/5 * * * *',
      body: {
        type: 'api.monitoring.health',
      },
      timeoutSeconds: readPositiveInteger('QSTASH_MONITORING_HEALTH_TIMEOUT_SECONDS', 20),
      retries,
    }),
    buildMonitoringSchedule({
      key: 'INCIDENTS',
      path: '/incidents',
      cron: process.env.QSTASH_MONITORING_INCIDENT_CRON || '*/5 * * * *',
      body: {
        type: 'api.monitoring.incidents',
        range: '1h',
      },
      timeoutSeconds: readPositiveInteger('QSTASH_MONITORING_INCIDENT_TIMEOUT_SECONDS', 20),
      retries,
    }),
    buildMonitoringSchedule({
      key: 'DAILY_SUMMARY',
      path: '/summary',
      cron: process.env.QSTASH_MONITORING_DAILY_SUMMARY_CRON || '5 0 * * *',
      body: {
        type: 'api.monitoring.summary',
        period: 'daily',
      },
      timeoutSeconds: readPositiveInteger('QSTASH_MONITORING_SUMMARY_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildMonitoringSchedule({
      key: 'WEEKLY_SUMMARY',
      path: '/summary',
      cron: process.env.QSTASH_MONITORING_WEEKLY_SUMMARY_CRON || '15 0 * * 1',
      body: {
        type: 'api.monitoring.summary',
        period: 'weekly',
      },
      timeoutSeconds: readPositiveInteger('QSTASH_MONITORING_SUMMARY_TIMEOUT_SECONDS', 30),
      retries,
    }),
  ];
}

export async function createMonitoringWorkflowSchedules() {
  if (!qstashClient) {
    throw new Error('QSTASH_TOKEN is required to create QStash monitoring schedules.');
  }

  const requests = buildMonitoringWorkflowSchedules();
  const results = [];

  for (const request of requests) {
    const result = await qstashClient.schedules.create(request);
    results.push({
      ...result,
      scheduleId: result.scheduleId || request.scheduleId,
      destination: request.destination,
      failureCallback: request.failureCallback,
      cron: request.cron,
      retries: request.retries,
      timeout: request.timeout,
    });
  }

  return results;
}

function buildPayoutSchedule({
  key,
  path,
  cron,
  body,
  timeoutSeconds = 30,
  retries = 3,
}) {
  const destination = getPayoutWorkflowUrl(path);
  if (!destination) {
    throw new Error('RENDER_BACKEND_URL is required to create QStash payout schedules.');
  }

  return {
    destination,
    cron,
    scheduleId: (process.env[`QSTASH_PAYOUT_${key}_SCHEDULE_ID`] || `payout-workflow-${key.toLowerCase()}`).trim(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
    body: JSON.stringify(body),
    retries,
    retryDelay: process.env.QSTASH_PAYOUT_RETRY_DELAY || '1000 * pow(2, retried)',
    timeout: timeoutSeconds,
    failureCallback: getPayoutWorkflowUrl('/failure'),
    label: process.env.QSTASH_PAYOUT_LABEL || 'creator-payout-workflows',
  };
}

export function buildPayoutWorkflowSchedules() {
  const retries = readPositiveInteger('QSTASH_PAYOUT_RETRIES', 3);
  return [
    buildPayoutSchedule({
      key: 'VERIFY',
      path: '/verify-due',
      cron: process.env.QSTASH_PAYOUT_VERIFY_CRON || '*/15 * * * *',
      body: { type: 'payout.verify_due' },
      timeoutSeconds: readPositiveInteger('QSTASH_PAYOUT_VERIFY_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildPayoutSchedule({
      key: 'DAILY_SUMMARY',
      path: '/daily-summary',
      cron: process.env.QSTASH_PAYOUT_DAILY_SUMMARY_CRON || '10 0 * * *',
      body: { type: 'payout.daily_summary' },
      timeoutSeconds: readPositiveInteger('QSTASH_PAYOUT_SUMMARY_TIMEOUT_SECONDS', 30),
      retries,
    }),
  ];
}

export async function createPayoutWorkflowSchedules() {
  if (!qstashClient) {
    throw new Error('QSTASH_TOKEN is required to create QStash payout schedules.');
  }

  const requests = buildPayoutWorkflowSchedules();
  const results = [];

  for (const request of requests) {
    const result = await qstashClient.schedules.create(request);
    results.push({
      ...result,
      scheduleId: result.scheduleId || request.scheduleId,
      destination: request.destination,
      failureCallback: request.failureCallback,
      cron: request.cron,
      retries: request.retries,
      timeout: request.timeout,
    });
  }

  return results;
}

function buildAiModerationSchedule({
  key,
  path,
  cron,
  body,
  timeoutSeconds = 30,
  retries = 3,
}) {
  const destination = getAiModerationWorkflowUrl(path);
  if (!destination) {
    throw new Error('RENDER_BACKEND_URL is required to create QStash AI moderation schedules.');
  }

  return {
    destination,
    cron,
    scheduleId: (process.env[`QSTASH_AI_MODERATION_${key}_SCHEDULE_ID`] || `ai-moderation-${key.toLowerCase()}`).trim(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
    body: JSON.stringify(body),
    retries,
    retryDelay: process.env.QSTASH_AI_MODERATION_RETRY_DELAY || '1000 * pow(2, retried)',
    timeout: timeoutSeconds,
    failureCallback: getAiModerationWorkflowUrl('/failure'),
    label: process.env.QSTASH_AI_MODERATION_LABEL || 'ai-moderation-workflows',
  };
}

export function buildAiModerationWorkflowSchedules() {
  const retries = readPositiveInteger('QSTASH_AI_MODERATION_RETRIES', 3);
  return [
    buildAiModerationSchedule({
      key: 'AGGREGATE',
      path: '/aggregate',
      cron: process.env.QSTASH_AI_MODERATION_AGGREGATE_CRON || '*/5 * * * *',
      body: { type: 'ai_moderation.aggregate', rangeMinutes: readPositiveInteger('AI_MODERATION_AGGREGATE_RANGE_MINUTES', 15) },
      timeoutSeconds: readPositiveInteger('QSTASH_AI_MODERATION_AGGREGATE_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildAiModerationSchedule({
      key: 'ESCALATE',
      path: '/escalate',
      cron: process.env.QSTASH_AI_MODERATION_ESCALATION_CRON || '*/10 * * * *',
      body: { type: 'ai_moderation.escalate' },
      timeoutSeconds: readPositiveInteger('QSTASH_AI_MODERATION_ESCALATION_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildAiModerationSchedule({
      key: 'SUMMARY',
      path: '/summary',
      cron: process.env.QSTASH_AI_MODERATION_SUMMARY_CRON || '20 0 * * *',
      body: { type: 'ai_moderation.daily_summary' },
      timeoutSeconds: readPositiveInteger('QSTASH_AI_MODERATION_SUMMARY_TIMEOUT_SECONDS', 30),
      retries,
    }),
  ];
}

export async function createAiModerationWorkflowSchedules() {
  if (!qstashClient) {
    throw new Error('QSTASH_TOKEN is required to create QStash AI moderation schedules.');
  }

  const requests = buildAiModerationWorkflowSchedules();
  const results = [];

  for (const request of requests) {
    const result = await qstashClient.schedules.create(request);
    results.push({
      ...result,
      scheduleId: result.scheduleId || request.scheduleId,
      destination: request.destination,
      failureCallback: request.failureCallback,
      cron: request.cron,
      retries: request.retries,
      timeout: request.timeout,
    });
  }

  return results;
}

function buildMonetizationSchedule({
  key,
  path,
  cron,
  body,
  timeoutSeconds = 30,
  retries = 3,
}) {
  const destination = getMonetizationWorkflowUrl(path);
  if (!destination) {
    throw new Error('RENDER_BACKEND_URL is required to create QStash monetization schedules.');
  }

  return {
    destination,
    cron,
    scheduleId: (process.env[`QSTASH_MONETIZATION_${key}_SCHEDULE_ID`] || `monetization-${key.toLowerCase()}`).trim(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Source': 'upstash-qstash',
    },
    body: JSON.stringify(body),
    retries,
    retryDelay: process.env.QSTASH_MONETIZATION_RETRY_DELAY || '1000 * pow(2, retried)',
    timeout: timeoutSeconds,
    failureCallback: getMonetizationWorkflowUrl('/failure'),
    label: process.env.QSTASH_MONETIZATION_LABEL || 'monetization-workflows',
  };
}

export function buildMonetizationWorkflowSchedules() {
  const retries = readPositiveInteger('QSTASH_MONETIZATION_RETRIES', 3);
  return [
    buildMonetizationSchedule({
      key: 'EXPIRATION',
      path: '/expire-memberships',
      cron: process.env.QSTASH_MONETIZATION_EXPIRATION_CRON || '*/15 * * * *',
      body: { type: 'monetization.memberships.expire' },
      timeoutSeconds: readPositiveInteger('QSTASH_MONETIZATION_EXPIRATION_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildMonetizationSchedule({
      key: 'REMINDERS',
      path: '/renewal-reminders',
      cron: process.env.QSTASH_MONETIZATION_REMINDER_CRON || '0 */6 * * *',
      body: { type: 'monetization.memberships.reminders', days: [7, 3, 1] },
      timeoutSeconds: readPositiveInteger('QSTASH_MONETIZATION_REMINDER_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildMonetizationSchedule({
      key: 'ANALYTICS',
      path: '/analytics',
      cron: process.env.QSTASH_MONETIZATION_ANALYTICS_CRON || '10 * * * *',
      body: { type: 'monetization.analytics.aggregate' },
      timeoutSeconds: readPositiveInteger('QSTASH_MONETIZATION_ANALYTICS_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildMonetizationSchedule({
      key: 'PAYMENT_INTENT_EXPIRATION',
      path: '/expire-payment-intents',
      cron: process.env.QSTASH_PAYMENT_INTENT_EXPIRATION_CRON || '*/10 * * * *',
      body: { type: 'payments.expire_stale_intents', limit: readPositiveInteger('PAYMENT_EXPIRE_LIMIT', 500) },
      timeoutSeconds: readPositiveInteger('QSTASH_PAYMENT_INTENT_EXPIRATION_TIMEOUT_SECONDS', 30),
      retries,
    }),
    buildMonetizationSchedule({
      key: 'PAYMENT_RECONCILIATION',
      path: '/payment-reconciliation',
      cron: process.env.QSTASH_PAYMENT_RECONCILIATION_CRON || '*/30 * * * *',
      body: { type: 'payments.reconcile' },
      timeoutSeconds: readPositiveInteger('QSTASH_PAYMENT_RECONCILIATION_TIMEOUT_SECONDS', 45),
      retries,
    }),
    buildMonetizationSchedule({
      key: 'PAYMENT_FRAUD_ANALYSIS',
      path: '/fraud-analysis',
      cron: process.env.QSTASH_PAYMENT_FRAUD_ANALYSIS_CRON || '*/15 * * * *',
      body: { type: 'payments.fraud_analysis' },
      timeoutSeconds: readPositiveInteger('QSTASH_PAYMENT_FRAUD_ANALYSIS_TIMEOUT_SECONDS', 30),
      retries,
    }),
  ];
}

export async function createMonetizationWorkflowSchedules() {
  if (!qstashClient) {
    throw new Error('QSTASH_TOKEN is required to create QStash monetization schedules.');
  }

  const requests = buildMonetizationWorkflowSchedules();
  const results = [];

  for (const request of requests) {
    const result = await qstashClient.schedules.create(request);
    results.push({
      ...result,
      scheduleId: result.scheduleId || request.scheduleId,
      destination: request.destination,
      failureCallback: request.failureCallback,
      cron: request.cron,
      retries: request.retries,
      timeout: request.timeout,
    });
  }

  return results;
}
