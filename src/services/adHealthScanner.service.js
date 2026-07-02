import { supabase } from '../config/supabase.js';
import {
  listProviders,
  getPriorityOrder,
  invalidateConfigCache,
} from './adProvider.service.js';
import { getPlatformSettingsMap, resolveVastSettingsFromMap } from './platformSettings.service.js';
import { isApprovedMonetagScriptUrl } from './safeAdPolicy.service.js';
import { verifyJuicyAdsCspPolicy } from '../utils/juicyAdsCspVerify.js';

const ALLOWED_SCRIPT_HOSTS = [
  'juicyads.com',
  'js.juicyads.com',
  'poweredby.jads.co',
  'jads.co',
  'a.magsrv.com',
  's.magsrv.com',
  'magsrv.com',
  'vast.yomeno.xyz',
  'yomeno.xyz',
  'securepubads.g.doubleclick.net',
  'googlesyndication.com',
  'quge5.com',
  'monetag.com',
  'highperformanceformat.com',
  'effectivecpmnetwork.com',
  'pl30142051.effectivecpmnetwork.com',
  'profitablecpmrate.com',
  'profitablecpmgate.com',
  'alwingulla.com',
  'kettledroopingcontinuation.com',
  'sleepoverlimitprofound.com',
  'fizzyacerbitymellow.com',
  'cloudvideosa.com',
  'protrafficinspector.com',
  '5gvci.com',
];
const BLOCKED_SCRIPT_PATTERN =
  /adserver\.juicyads\.com|popunder|clickunder|interstitial|popup|auto.?redirect|direct.?link|social.?bar|window\.open|top\.location|betway|casino|popads|popcash|propellerads|onclickads/i;
const EXOCLICK_VAST_TAG_URL = 'https://s.magsrv.com/v1/vast.php?idz=5963164';
const LEGACY_EXOCLICK_VAST_TAG_URLS = new Set([
  'https://s.magsrv.com/v1/vast.php?idz=5932212',
  'https://s.magsrv.com/v1/vast.php?idz=5933056',
  'https://s.magsrv.com/v1/vast.php?idzone=5932212',
  'https://s.magsrv.com/v1/vast.php?idzone=5933056',
]);

let scanTimer = null;

export function isAllowedAdUrl(url) {
  if (!url) return true;
  if (isApprovedMonetagScriptUrl(url)) return true;
  if (String(url).toLowerCase().includes('quge5.com')) return false;
  if (BLOCKED_SCRIPT_PATTERN.test(String(url).toLowerCase())) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return ALLOWED_SCRIPT_HOSTS.some((h) => {
      if (h === 'juicyads.com') return host === h;
      return host === h || host.endsWith(`.${h}`);
    });
  } catch {
    return false;
  }
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const octet = Number(match172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

function isAllowedVastProbeUrl(url) {
  if (!url) return false;
  if (BLOCKED_SCRIPT_PATTERN.test(String(url).toLowerCase())) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

export async function probeVastTag(tagUrl, timeoutMs = 5000) {
  const start = Date.now();
  if (!tagUrl || !isAllowedVastProbeUrl(tagUrl)) {
    return { status: 'failed', responseMs: 0, errorCode: 'invalid_url', errorMessage: 'Tag URL not allowed' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(tagUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/xml,text/xml,*/*' },
    });
    clearTimeout(timer);
    const text = await res.text();
    const responseMs = Date.now() - start;
    if (!res.ok) {
      return { status: 'failed', responseMs, errorCode: `http_${res.status}`, errorMessage: `HTTP ${res.status}` };
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 20) {
      return { status: 'failed', responseMs, errorCode: 'empty_vast', errorMessage: 'Empty VAST response' };
    }
    if (!/<VAST/i.test(trimmed) && !/<vast/i.test(trimmed)) {
      return { status: 'degraded', responseMs, errorCode: 'invalid_vast', errorMessage: 'Response is not valid VAST XML' };
    }
    if (!/<Ad(?=[\s>])/i.test(trimmed)) {
      return { status: 'failed', responseMs, errorCode: 'empty_vast', errorMessage: 'VAST response has no Ad blocks' };
    }
    return { status: 'healthy', responseMs, diagnostics: { bytes: trimmed.length } };
  } catch (err) {
    clearTimeout(timer);
    const responseMs = Date.now() - start;
    const isTimeout = err?.name === 'AbortError';
    return {
      status: 'failed',
      responseMs,
      errorCode: isTimeout ? 'timeout' : 'network_error',
      errorMessage: err?.message || 'Probe failed',
    };
  }
}

export async function probeScriptUrl(scriptUrl, timeoutMs = 8000) {
  const start = Date.now();
  if (!scriptUrl) return { status: 'degraded', responseMs: 0, errorCode: 'no_script', errorMessage: 'No script URL configured' };
  if (!isAllowedAdUrl(scriptUrl)) {
    return { status: 'failed', responseMs: 0, errorCode: 'blocked_domain', errorMessage: 'Script domain not in allowlist' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(scriptUrl, { signal: controller.signal, method: 'HEAD' });
    clearTimeout(timer);
    const responseMs = Date.now() - start;
    if (!res.ok) {
      return { status: 'failed', responseMs, errorCode: `http_${res.status}`, errorMessage: `Script HTTP ${res.status}` };
    }
    return { status: 'healthy', responseMs };
  } catch (err) {
    clearTimeout(timer);
    return {
      status: 'failed',
      responseMs: Date.now() - start,
      errorCode: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      errorMessage: err?.message || 'Script probe failed',
    };
  }
}

function normalizeExoClickVastUrl(url) {
  const value = String(url || '').trim();
  return LEGACY_EXOCLICK_VAST_TAG_URLS.has(value) ? EXOCLICK_VAST_TAG_URL : value;
}

export async function scanProvider(provider, checkType = 'scheduled') {
  let result;
  if (provider.provider_type === 'vast') {
    const settings = await getPlatformSettingsMap();
    const activeVast = resolveVastSettingsFromMap(settings);
    const zones = await import('./adProvider.service.js').then((m) => m.listZones(provider.id));
    const tagUrl = normalizeExoClickVastUrl(activeVast.url
      || zones.find((z) => z.placement === 'video_preroll' && z.tag_url)?.tag_url
      || zones.find((z) => /\/vast\.php|vast/i.test(String(z.tag_url || '')))?.tag_url
      || process.env.EXOCLICK_VAST_TAG_URL
      || EXOCLICK_VAST_TAG_URL);
    result = await probeVastTag(tagUrl, provider.timeout_ms || 5000);
  } else if (provider.script_url) {
    result = await probeScriptUrl(provider.script_url, provider.timeout_ms || 8000);
  } else {
    result = { status: 'degraded', responseMs: 0, errorCode: 'no_probe', errorMessage: 'No probe target for provider' };
  }

  if (supabase) {
    await supabase.from('ad_provider_health_checks').insert({
      provider_id: provider.id,
      status: result.status,
      check_type: checkType,
      response_ms: result.responseMs,
      error_code: result.errorCode || null,
      error_message: result.errorMessage || null,
      diagnostics: result.diagnostics || {},
    });
  }

  return { providerId: provider.id, ...result };
}

export async function runFullHealthScan(checkType = 'scheduled') {
  const providers = await listProviders();
  const results = [];
  for (const p of providers.filter((x) => x.is_enabled)) {
    results.push(await scanProvider(p, checkType));
  }
  invalidateConfigCache();
  return results;
}

export async function resolveFallbackProvider(failedProviderId, placement = null) {
  const settings = await getPlatformSettingsMap();
  if (settings.ad_auto_fallback_enabled === 'false') return null;

  const [providers, priority] = await Promise.all([listProviders(), getPriorityOrder()]);
  const enabled = providers.filter((p) => p.is_enabled && !p.is_maintenance && p.id !== failedProviderId);
  const ordered = priority
    .map((slug) => enabled.find((p) => p.slug === slug))
    .filter(Boolean)
    .concat(enabled.filter((p) => !priority.includes(p.slug)));

  const next = ordered[0];
  if (!next) return null;

  await scanProvider(next, 'auto_fallback');
  return next;
}

export function startHealthScanScheduler() {
  if (scanTimer) return;
  const tick = async () => {
    try {
      const settings = await getPlatformSettingsMap();
      const mins = Math.max(5, Number(settings.ad_health_scan_interval_minutes || 15));
      await runFullHealthScan('scheduled');
      scanTimer = setTimeout(tick, mins * 60_000);
    } catch (err) {
      console.error('[adHealthScanner] scan failed:', err?.message || err);
      scanTimer = setTimeout(tick, 15 * 60_000);
    }
  };
  scanTimer = setTimeout(tick, 30_000);
}

export function stopHealthScanScheduler() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
}

export async function getHealthHistory(providerId = null, limit = 50) {
  if (!supabase) return [];
  let query = supabase.from('ad_provider_health_checks').select('*').order('created_at', { ascending: false }).limit(limit);
  if (providerId) query = query.eq('provider_id', providerId);
  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

export async function getJuicyAdsDiagnostics() {
  const providers = await listProviders();
  const juicy = providers.find((p) => p.slug === 'juicyads');
  const zones = juicy ? await import('./adProvider.service.js').then((m) => m.listZones('juicyads')) : [];
  const scriptProbe = juicy?.script_url ? await probeScriptUrl(juicy.script_url) : null;

  return {
    provider: juicy,
    zones,
    scriptProbe,
    checks: [
      { id: 'script_allowlist', label: 'Script domain allowlist', pass: isAllowedAdUrl(juicy?.script_url), detail: juicy?.script_url || 'missing' },
      { id: 'provider_enabled', label: 'Provider enabled', pass: juicy?.is_enabled === true && juicy?.is_maintenance !== true },
      { id: 'zones_configured', label: 'Active zones configured', pass: zones.some((z) => z.is_active) },
      { id: 'script_reachable', label: 'Script URL reachable', pass: scriptProbe?.status === 'healthy', detail: scriptProbe?.errorMessage },
      (() => {
        const csp = verifyJuicyAdsCspPolicy();
        return { id: 'csp_juicyads', label: 'CSP allows JuicyAds (script/frame/connect)', pass: csp.pass, detail: csp.detail };
      })(),
      { id: 'mobile_visibility', label: 'Mobile visibility', pass: true, detail: 'Wide banner slots no longer force desktop-only visibility.' },
      { id: 'fallback_only', label: 'Juicy only when no first-party campaign', pass: null, detail: 'AdBanner shows Juicy only when /api/ads/placement returns null' },
    ],
  };
}
