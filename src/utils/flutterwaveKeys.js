const TEST_SECRET_PREFIX = /^FLWSECK[_-]TEST/i;
const TEST_PUBLIC_PREFIX = /^FLWPUBK[_-]TEST/i;
const LIVE_SECRET_PREFIX = /^FLWSECK-/i;
const LIVE_PUBLIC_PREFIX = /^FLWPUBK-/i;

export function isProductionEnv(env = process.env) {
  return ['NODE_ENV', 'APP_ENV', 'ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT']
    .some((key) => String(env[key] || '').toLowerCase() === 'production');
}

function modeForKey(value, { testPrefix, livePrefix }) {
  const key = String(value || '').trim();
  if (!key) return 'missing';
  if (testPrefix.test(key)) return 'test';
  if (livePrefix.test(key)) return 'live';
  return 'unknown';
}

export function flutterwaveSecretMode(value) {
  return modeForKey(value, { testPrefix: TEST_SECRET_PREFIX, livePrefix: LIVE_SECRET_PREFIX });
}

export function flutterwavePublicMode(value) {
  return modeForKey(value, { testPrefix: TEST_PUBLIC_PREFIX, livePrefix: LIVE_PUBLIC_PREFIX });
}

export function assertFlutterwaveLiveSecretForProduction(value = process.env.FLUTTERWAVE_SECRET_KEY, env = process.env) {
  if (!isProductionEnv(env)) return;
  const mode = flutterwaveSecretMode(value);
  if (mode === 'test') {
    throw new Error('FLUTTERWAVE_SECRET_KEY is a Flutterwave TEST key. Use your live secret key in production.');
  }
  if (mode !== 'live') {
    throw new Error('FLUTTERWAVE_SECRET_KEY must be a Flutterwave live secret key starting with FLWSECK- in production.');
  }
}
