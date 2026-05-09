export function publicFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

export function publicApiUrl() {
  return (process.env.API_PUBLIC_URL || process.env.BACKEND_PUBLIC_URL || '').replace(/\/$/, '');
}

export function isLocalDevUrlsConfigured() {
  const front = String(process.env.FRONTEND_URL || '').toLowerCase();
  const api = String(process.env.API_PUBLIC_URL || process.env.BACKEND_PUBLIC_URL || '').toLowerCase();
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
