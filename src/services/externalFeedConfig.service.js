import { supabase } from '../config/supabase.js';

export const EXTERNAL_FEED_SETTINGS_KEY = 'external_feed_config';

const CONFIG_TTL_MS = 30_000;
let cachedConfig = null;
let cacheLoadedAt = 0;

export function getDefaultExternalFeedConfig() {
  return {
    enabled: true,
    activeProvider: 'xnxx-api',
    mixCreatorsFirst: true,
    pagesPerRequest: 1,
    providers: {
      'xnxx-api': {
        label: 'XNXX API (RapidAPI)',
        host: process.env.RAPIDAPI_XNXX_HOST || 'xnxx-api.p.rapidapi.com',
        apiKey: process.env.RAPIDAPI_XNXX_API_KEY || process.env.RAPIDAPI_XNXX_KEY || process.env.RAPIDAPI_KEY || '',
        bestPath: '/xn/best',
        periodMode: 'none',
        fixedPeriod: '',
      },
    },
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base, ...patch };
  if (patch.providers && typeof patch.providers === 'object') {
    out.providers = { ...base.providers };
    for (const [id, prov] of Object.entries(patch.providers)) {
      out.providers[id] = { ...(base.providers?.[id] || {}), ...prov };
    }
  }
  return out;
}

function normalizeConfig(raw) {
  const defaults = getDefaultExternalFeedConfig();
  const merged = deepMerge(defaults, raw && typeof raw === 'object' ? raw : {});
  merged.enabled = merged.enabled !== false;
  merged.activeProvider = String(merged.activeProvider || 'xnxx-api');
  merged.mixCreatorsFirst = merged.mixCreatorsFirst !== false;
  const pages = Number(merged.pagesPerRequest);
  merged.pagesPerRequest = Number.isFinite(pages) ? Math.min(5, Math.max(1, Math.floor(pages))) : 1;
  if (!merged.providers || typeof merged.providers !== 'object') {
    merged.providers = { ...defaults.providers };
  }
  for (const id of Object.keys(merged.providers)) {
    const p = merged.providers[id];
    if (!p || typeof p !== 'object') continue;
    p.host = String(p.host || defaults.providers['xnxx-api']?.host || 'xnxx-api.p.rapidapi.com').trim();
    p.bestPath = String(p.bestPath || '/xn/best').trim() || '/xn/best';
    p.periodMode = ['current_month', 'fixed', 'none'].includes(p.periodMode) ? p.periodMode : 'none';
    p.fixedPeriod = String(p.fixedPeriod || '').trim();
    if (!p.label) p.label = id;
  }
  if (!merged.providers[merged.activeProvider]) {
    merged.activeProvider = 'xnxx-api';
  }
  return merged;
}

export function resolveFeedPeriod(providerConfig) {
  if (!providerConfig || providerConfig.periodMode === 'none') return null;
  if (providerConfig.periodMode === 'fixed') {
    const p = String(providerConfig.fixedPeriod || '').trim();
    return /^\d{4}-\d{2}$/.test(p) ? p : null;
  }
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function maskApiKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${'•'.repeat(Math.min(16, s.length - 4))}${s.slice(-4)}`;
}

export function isMaskedKeyInput(value) {
  const s = String(value || '');
  return !s || /^•+$/.test(s.replace(/\d{4}$/, ''));
}

export async function loadExternalFeedConfig(force = false) {
  if (!force && cachedConfig && Date.now() - cacheLoadedAt < CONFIG_TTL_MS) {
    return cachedConfig;
  }

  let fromDb = null;
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', EXTERNAL_FEED_SETTINGS_KEY)
      .maybeSingle();
    if (!error && data?.value) {
      fromDb = JSON.parse(data.value);
    }
  } catch (_) {
    /* use defaults */
  }

  cachedConfig = normalizeConfig(fromDb);
  cacheLoadedAt = Date.now();
  return cachedConfig;
}

export function getExternalFeedConfigSync() {
  return cachedConfig || normalizeConfig(null);
}

export async function saveExternalFeedConfig(nextConfig, updatedBy = 'Admin') {
  const current = await loadExternalFeedConfig(true);
  const normalized = normalizeConfig(nextConfig);

  const activeId = normalized.activeProvider;
  const nextProvider = normalized.providers[activeId] || {};
  const currentProvider = current.providers[activeId] || {};

  if (isMaskedKeyInput(nextProvider.apiKey) && currentProvider.apiKey) {
    nextProvider.apiKey = currentProvider.apiKey;
  }

  normalized.providers[activeId] = nextProvider;

  const payload = JSON.stringify(normalized);
  const row = {
    key: EXTERNAL_FEED_SETTINGS_KEY,
    value: payload,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('platform_settings').upsert(row, { onConflict: 'key' });
  if (error) throw error;

  cachedConfig = normalized;
  cacheLoadedAt = Date.now();
  return normalized;
}

export function invalidateExternalFeedConfigCache() {
  cachedConfig = null;
  cacheLoadedAt = 0;
}

export async function getActiveProviderRuntime() {
  const config = await loadExternalFeedConfig();
  const provider = config.providers[config.activeProvider] || config.providers['xnxx-api'];
  return {
    config,
    provider,
    period: resolveFeedPeriod(provider),
    configured: Boolean(provider?.apiKey && provider.apiKey.length >= 10 && provider.apiKey !== 'YOUR_API_KEY'),
  };
}

export function configForAdminResponse(config) {
  const out = normalizeConfig(config);
  const active = out.providers[out.activeProvider];
  if (active) {
    out.providers = {
      ...out.providers,
      [out.activeProvider]: {
        ...active,
        apiKey: maskApiKey(active.apiKey),
        hasApiKey: Boolean(active.apiKey && active.apiKey.length >= 10),
      },
    };
  }
  out.resolvedPeriod = resolveFeedPeriod(active);
  return out;
}

export async function preloadExternalFeedConfig() {
  await loadExternalFeedConfig(true);
}
