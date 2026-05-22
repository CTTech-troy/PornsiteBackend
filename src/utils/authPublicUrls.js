function parseUrlCandidates(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isValidAbsoluteUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLocalHostUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * FRONTEND_URL / FRONTEND_PUBLIC_URL are often comma-separated lists in .env.
 * Firebase action links require a single absolute continue URL.
 */
function resolvePublicUrl(envKeys, fallback) {
  const preferLocal = process.env.NODE_ENV !== 'production';
  const lists = envKeys.map((key) => parseUrlCandidates(process.env[key]));
  const ordered = preferLocal ? lists.reverse().flat() : lists.flat();
  const valid = ordered.filter(isValidAbsoluteUrl);

  if (preferLocal) {
    const local = valid.find(isLocalHostUrl);
    if (local) return local.replace(/\/$/, '');
  }

  const remoteHttps = valid.find((u) => u.startsWith('https://') && !isLocalHostUrl(u));
  if (remoteHttps) return remoteHttps.replace(/\/$/, '');

  if (valid[0]) return valid[0].replace(/\/$/, '');
  return fallback;
}

export function publicFrontendUrl() {
  return resolvePublicUrl(['FRONTEND_URL', 'FRONTEND_PUBLIC_URL'], 'http://localhost:5173');
}

export function publicApiUrl() {
  const resolved = resolvePublicUrl(
    ['API_PUBLIC_URL', 'BACKEND_PUBLIC_URL', 'BACKEND_URL'],
    ''
  );
  return resolved || '';
}

export function isLocalDevUrlsConfigured() {
  const front = `${process.env.FRONTEND_URL || ''},${process.env.FRONTEND_PUBLIC_URL || ''}`.toLowerCase();
  const api = `${process.env.API_PUBLIC_URL || ''},${process.env.BACKEND_PUBLIC_URL || ''},${process.env.BACKEND_URL || ''}`.toLowerCase();
  return (
    front.includes('localhost') ||
    front.includes('127.0.0.1') ||
    api.includes('localhost') ||
    api.includes('127.0.0.1')
  );
}

export function buildAppVerificationUrl(rawToken) {
  const front = publicFrontendUrl();
  const apiBase = publicApiUrl();
  return apiBase
    ? `${apiBase}/api/auth/verify-email/${encodeURIComponent(rawToken)}`
    : `${front}/auth/confirm-email?t=${encodeURIComponent(rawToken)}`;
}

export function buildPasswordResetContinueUrl() {
  const front = publicFrontendUrl();
  try {
    return new URL('/auth/reset-password', `${front}/`).href;
  } catch {
    return `${front}/auth/reset-password`;
  }
}
