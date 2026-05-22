import {
  aggregateApiMetrics,
  detectApiIncidents,
  generateApiSummary,
  getApiDetail,
  getApiOverview,
  getMonitoringIngestionState,
  getRequestLogs,
  runScheduledHealthChecks,
} from '../services/apiMonitoring.service.js';

function stringParam(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function intParam(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sendResult(res, result) {
  if (result?.success === false) return res.status(result.missingTable ? 503 : 500).json(result);
  return res.json(result);
}

export async function getObservabilityOverview(req, res) {
  try {
    const range = stringParam(req.query.range, '24h');
    const result = await getApiOverview({ range, forceFresh: req.query.fresh === '1' });
    return res.json(result);
  } catch (error) {
    console.error('[api-monitor] overview failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load API observability overview.' });
  }
}

export async function getObservedApis(req, res) {
  try {
    const range = stringParam(req.query.range, '24h');
    const result = await getApiOverview({ range, forceFresh: req.query.fresh === '1' });
    return res.json({ success: true, range, timestamp: result.timestamp, apis: result.apis });
  } catch (error) {
    console.error('[api-monitor] API list failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load observed APIs.' });
  }
}

export async function getObservedApiDetail(req, res) {
  try {
    const range = stringParam(req.query.range, '24h');
    const page = intParam(req.query.page, 1);
    const pageSize = intParam(req.query.pageSize, 25);
    const result = await getApiDetail(req.params.routeKey, { range, page, pageSize });
    if (!result.api) return res.status(404).json({ success: false, message: 'No monitoring data found for this API.' });
    return res.json(result);
  } catch (error) {
    console.error('[api-monitor] API detail failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load API detail.' });
  }
}

export async function getObservedRequestLogs(req, res) {
  try {
    const routeKey = req.query.routeKey ? decodeURIComponent(String(req.query.routeKey)) : null;
    const page = intParam(req.query.page, 1);
    const pageSize = intParam(req.query.pageSize, 25);
    const status = req.query.status ? String(req.query.status) : null;
    const result = await getRequestLogs({ routeKey, page, pageSize, status });
    return sendResult(res, result);
  } catch (error) {
    console.error('[api-monitor] logs failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to load API request logs.' });
  }
}

export async function getObservabilityState(req, res) {
  return res.json({
    success: true,
    timestamp: new Date().toISOString(),
    ingestion: getMonitoringIngestionState(),
  });
}

export async function runObservabilityAggregation(req, res) {
  try {
    const rangeMinutes = intParam(req.body?.rangeMinutes, 10);
    const bucketMinutes = intParam(req.body?.bucketMinutes, 1);
    const result = await aggregateApiMetrics({ rangeMinutes, bucketMinutes });
    return sendResult(res, result);
  } catch (error) {
    console.error('[api-monitor] manual aggregation failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to aggregate API metrics.' });
  }
}

export async function runObservabilityHealthChecks(req, res) {
  try {
    const result = await runScheduledHealthChecks();
    return sendResult(res, result);
  } catch (error) {
    console.error('[api-monitor] manual health checks failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to run API health checks.' });
  }
}

export async function runObservabilityIncidentScan(req, res) {
  try {
    const result = await detectApiIncidents({ range: stringParam(req.body?.range, '1h') });
    return sendResult(res, result);
  } catch (error) {
    console.error('[api-monitor] manual incident scan failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to scan API incidents.' });
  }
}

export async function runObservabilitySummary(req, res) {
  try {
    const period = stringParam(req.body?.period, 'daily');
    const result = await generateApiSummary({ period });
    return sendResult(res, result);
  } catch (error) {
    console.error('[api-monitor] manual summary failed:', error?.message || error);
    return res.status(500).json({ success: false, message: 'Failed to generate API summary.' });
  }
}
