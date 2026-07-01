import {
  getAdsOverview,
  getAdsPerformance,
  getAdsReport,
  getAdsRevenue,
  getAdsSettings,
  getAdsZones,
  reportToCsv,
  reportToExcelXml,
  streamReportPdf,
} from '../services/adsAnalytics.service.js';

function handleError(res, scope, err) {
  console.error(`[adsAnalytics] ${scope}:`, err?.message || err);
  return res.status(err?.status || 500).json({
    success: false,
    message: err?.message || 'Ads analytics is temporarily unavailable.',
  });
}

export async function getOverview(req, res) {
  try {
    const data = await getAdsOverview(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'overview', err);
  }
}

export async function getRevenue(req, res) {
  try {
    const data = await getAdsRevenue(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'revenue', err);
  }
}

export async function getZones(req, res) {
  try {
    const data = await getAdsZones(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'zones', err);
  }
}

export async function getPerformance(req, res) {
  try {
    const data = await getAdsPerformance(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'performance', err);
  }
}

export async function getReports(req, res) {
  try {
    const data = await getAdsReport(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'reports', err);
  }
}

export async function getSettings(req, res) {
  try {
    const data = await getAdsSettings(req.query || {});
    return res.json(data);
  } catch (err) {
    return handleError(res, 'settings', err);
  }
}

export async function exportReport(req, res) {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    const report = await getAdsReport(req.query || {});
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="ads-management-${stamp}.pdf"`);
      return streamReportPdf(res, report);
    }

    if (format === 'excel' || format === 'xlsx' || format === 'xls') {
      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ads-management-${stamp}.xls"`);
      return res.send(reportToExcelXml(report));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ads-management-${stamp}.csv"`);
    return res.send(reportToCsv(report));
  } catch (err) {
    return handleError(res, 'export', err);
  }
}
