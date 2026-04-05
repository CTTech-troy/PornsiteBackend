const counts = {
  loginOk: 0,
  loginFail: 0,
  signupOk: 0,
  signupFail: 0,
  rateLimited: 0,
};

export function recordAuth(metric) {
  if (typeof counts[metric] !== 'number') return;
  counts[metric] += 1;
}

export function getAuthMetricsSnapshot() {
  return { ...counts, ts: new Date().toISOString() };
}
