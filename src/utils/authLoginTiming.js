const enabled = () =>
  process.env.AUTH_LOGIN_TIMING === '1' ||
  process.env.AUTH_LOGIN_TIMING === 'true' ||
  process.env.AUTH_TIMING === '1' ||
  process.env.AUTH_TIMING === 'true';

export function createAuthTimer(prefix) {
  const t0 = process.hrtime.bigint();
  let prev = t0;
  return (label) => {
    if (!enabled()) return;
    const now = process.hrtime.bigint();
    const stepMs = Number(now - prev) / 1e6;
    const totalMs = Number(now - t0) / 1e6;
    prev = now;
    console.log(`[${prefix}] ${label}: ${stepMs.toFixed(1)}ms (total ${totalMs.toFixed(1)}ms)`);
  };
}

export function createLoginTimer() {
  return createAuthTimer('auth/login');
}

export function createSignupTimer() {
  return createAuthTimer('auth/signup');
}
