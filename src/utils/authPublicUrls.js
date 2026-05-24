import { expandUrlCandidates, isLocalUrl, resolvePublicApiUrl, resolvePublicFrontendUrl } from './appUrls.js';

function preferUrl(envKeys, fallbackResolver) {
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const candidates = envKeys.flatMap((key) => expandUrlCandidates(process.env[key]));
  const remote = candidates.find((url) => url.startsWith('https://') && !isLocalUrl(url));
  if (remote) return remote.replace(/\/$/, '');
  const safe = candidates.find((url) => !production || !isLocalUrl(url));
  if (safe) return safe.replace(/\/$/, '');
  return fallbackResolver().replace(/\/$/, '');
}

export function publicFrontendUrl() {
  return preferUrl(['FRONTEND_URL', 'FRONTEND_PUBLIC_URL'], resolvePublicFrontendUrl);
}

export function publicApiUrl() {
  return preferUrl(['API_PUBLIC_URL', 'BACKEND_PUBLIC_URL', 'BACKEND_URL'], resolvePublicApiUrl);
}

export function isLocalDevUrlsConfigured() {
  const values = [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_PUBLIC_URL,
    process.env.API_PUBLIC_URL,
    process.env.BACKEND_PUBLIC_URL,
    process.env.BACKEND_URL,
  ];
  return values.flatMap((value) => expandUrlCandidates(value)).some(isLocalUrl);
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
