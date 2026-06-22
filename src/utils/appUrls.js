const LOOPBACK_HOSTS = new Set([
  ['local', 'host'].join(''),
  ['127', '0', '0', '1'].join('.'),
  ['0', '0', '0', '0'].join('.'),
  '[::1]',
  '::1',
]);

function trimUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function isValidAbsoluteUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isLocalHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

export function isLocalUrl(url) {
  if (!url || !isValidAbsoluteUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isProductionEnv() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const appEnv = String(process.env.APP_ENV || process.env.RAILWAY_ENVIRONMENT || '').toLowerCase();
  if (appEnv === 'production') return true;
  if (appEnv === 'development' || appEnv === 'staging') return false;
  return nodeEnv === 'production';
}

/**
 * Env vars may be a single URL or comma-separated list (e.g. prod + dev by mistake).
 * Each entry is trimmed; invalid tokens are dropped.
 */
export function expandUrlCandidates(...values) {
  const out = [];
  for (const value of values) {
    if (value == null) continue;
    const parts = String(value).split(/[,;\s]+/).map(trimUrl).filter(Boolean);
    for (const part of parts) {
      if (isValidAbsoluteUrl(part)) out.push(part);
    }
  }
  return out;
}

function pickUrl(candidates, { allowLocalhost = false } = {}) {
  const production = isProductionEnv();
  const expanded = expandUrlCandidates(...candidates);

  for (const url of expanded) {
    if (production && !allowLocalhost && isLocalUrl(url)) {
      continue;
    }
    return url;
  }
  return null;
}

export const PRODUCTION_ADMIN_DEFAULT = 'https://admin.xstreamvideos.site';
export const PRODUCTION_PUBLIC_DEFAULT = 'https://xstreamvideos.site';
export const PRODUCTION_API_DEFAULT = 'https://api.xstreamvideos.site';
export const PRODUCTION_PAYMENT_SERVICE_DEFAULT = 'https://pornsite-paymentsystem-1.onrender.com';

export function resolveAdminFrontendUrl() {
  const production = isProductionEnv();
  const url = pickUrl([
    process.env.ADMIN_FRONTEND_URL,
    process.env.ADMIN_APP_URL,
    process.env.ADMIN_SITE_URL,
    process.env.VITE_ADMIN_FRONTEND_URL,
    PRODUCTION_ADMIN_DEFAULT,
  ], { allowLocalhost: !production });

  if (!url) {
    throw new Error(
      production
        ? 'ADMIN_FRONTEND_URL is not configured for production.'
        : 'Could not resolve admin frontend URL.',
    );
  }
  return url;
}

export function resolvePublicFrontendUrl() {
  const production = isProductionEnv();
  return pickUrl([
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    process.env.APP_URL,
    process.env.PUBLIC_SITE_URL,
    process.env.SITE_URL,
    PRODUCTION_PUBLIC_DEFAULT,
  ], { allowLocalhost: !production }) || PRODUCTION_PUBLIC_DEFAULT;
}

export function resolvePublicApiUrl() {
  return pickUrl([
    process.env.API_PUBLIC_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.BACKEND_URL,
    process.env.PUBLIC_API_URL,
    process.env.API_BASE_URL,
    PRODUCTION_API_DEFAULT,
  ], { allowLocalhost: !isProductionEnv() }) || PRODUCTION_API_DEFAULT;
}

export function resolvePaymentServiceUrl() {
  return pickUrl([
    process.env.PAYMENT_SERVICE_URL,
    process.env.PAYMENT_API_URL,
    process.env.PROD_PAYMENT_SERVICE_URL,
    process.env.PROD_PAYMENT_API_URL,
    PRODUCTION_PAYMENT_SERVICE_DEFAULT,
  ], { allowLocalhost: !isProductionEnv() }) || PRODUCTION_PAYMENT_SERVICE_DEFAULT;
}

export function buildAdminInviteUrl(token) {
  const base = resolveAdminFrontendUrl();
  const safeToken = encodeURIComponent(String(token || '').trim());
  return `${base}/invite/complete?token=${safeToken}`;
}

export function validateAppUrlConfig({ log = console } = {}) {
  const production = isProductionEnv();
  const issues = [];

  const rawAdmin = process.env.ADMIN_FRONTEND_URL;
  if (production && rawAdmin && isLocalUrl(rawAdmin)) {
    log.warn?.('[urls] ADMIN_FRONTEND_URL contains a loopback URL; ignored in production.');
  }

  try {
    const adminUrl = resolveAdminFrontendUrl();
    log.info?.(`[urls] Admin frontend: ${adminUrl}`);
    if (production && isLocalUrl(adminUrl)) {
      issues.push('Admin frontend URL resolves to a loopback URL in production.');
    }
  } catch (err) {
    issues.push(err.message);
  }

  try {
    const publicUrl = resolvePublicFrontendUrl();
    log.info?.(`[urls] Public frontend: ${publicUrl}`);
    if (production && isLocalUrl(publicUrl)) {
      issues.push('Public frontend URL resolves to a loopback URL in production.');
    }
  } catch (err) {
    issues.push(err.message);
  }

  try {
    const apiUrl = resolvePublicApiUrl();
    log.info?.(`[urls] Public API: ${apiUrl}`);
    if (production && isLocalUrl(apiUrl)) {
      issues.push('Public API URL resolves to a loopback URL in production.');
    }
  } catch (err) {
    issues.push(err.message);
  }

  try {
    const paymentUrl = resolvePaymentServiceUrl();
    log.info?.(`[urls] Payment service: ${paymentUrl}`);
    if (production && isLocalUrl(paymentUrl)) {
      issues.push('Payment service URL resolves to a loopback URL in production.');
    }
  } catch (err) {
    issues.push(err.message);
  }

  if (issues.length) {
    const message = `[urls] Configuration warning:\n- ${issues.join('\n- ')}`;
    if (production) {
      log.error?.(message);
    } else {
      log.warn?.(message);
    }
  }

  return { ok: issues.length === 0, issues, production };
}
