import { randomUUID } from 'crypto';
import { supabase } from '../config/supabase.js';
import {
  loadExternalFeedConfig,
  saveExternalFeedConfig,
  configForAdminResponse,
  invalidateExternalFeedConfigCache,
  getActiveProviderRuntime,
} from '../services/externalFeedConfig.service.js';
import { clearXnxxBestPageCache, fetchXnxxBestPage } from '../utils/xnxxRapidApi.js';

async function logAction(adminId, adminName, action, details = {}) {
  try {
    await supabase.from('admin_audit_logs').insert({
      id: randomUUID(),
      admin_id: adminId || null,
      admin_name: adminName || 'Admin',
      action,
      target_type: 'external_feed',
      target_id: 'config',
      details,
      status: 'success',
    });
  } catch (_) {}
}

export async function getExternalFeedConfig(req, res) {
  try {
    const config = await loadExternalFeedConfig(true);
    return res.json({ success: true, config: configForAdminResponse(config) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed to load config' });
  }
}

export async function updateExternalFeedConfig(req, res) {
  try {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ success: false, message: 'config object required' });
    }
    const saved = await saveExternalFeedConfig(config, req.admin?.name || 'Admin');
    clearXnxxBestPageCache();
    invalidateExternalFeedConfigCache();
    await logAction(req.admin?.id, req.admin?.name, 'External feed config updated', {
      activeProvider: saved.activeProvider,
      enabled: saved.enabled,
    });
    return res.json({ success: true, config: configForAdminResponse(saved), message: 'External feed settings saved.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed to save config' });
  }
}

export async function testExternalFeedConfig(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    invalidateExternalFeedConfigCache();
    clearXnxxBestPageCache();
    const runtime = await getActiveProviderRuntime();
    if (!runtime.config.enabled) {
      return res.json({ success: false, message: 'External feed is disabled in settings.' });
    }
    if (!runtime.configured) {
      return res.json({ success: false, message: 'API key is not configured. Set it in External Feed or RAPIDAPI_XNXX_API_KEY env.' });
    }
    const { ok, items, status, error, stale, cached } = await fetchXnxxBestPage(page);
    return res.json({
      success: ok,
      message: ok
        ? `Fetched ${items?.length || 0} videos (page ${page}, period ${runtime.period || 'none'}).`
        : (error || `Request failed${status ? ` (${status})` : ''}`),
      sampleCount: items?.length || 0,
      period: runtime.period,
      page,
      stale: !!stale,
      cached: !!cached,
      preview: (items || []).slice(0, 3).map((v) => ({ id: v.id, title: v.title, thumbnail: v.thumbnail })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Test failed' });
  }
}

export async function getExternalFeedMeta(req, res) {
  try {
    const runtime = await getActiveProviderRuntime();
    return res.json({
      success: true,
      enabled: runtime.config.enabled,
      activeProvider: runtime.config.activeProvider,
      configured: runtime.configured,
      period: runtime.period,
      periodMode: runtime.provider?.periodMode,
      host: runtime.provider?.host,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
}
