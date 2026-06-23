import test from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'PAYMENT_SERVICE_URL',
  'PAYMENT_SERVICE_SHARED_SECRET',
  'FLUTTERWAVE_ENABLED',
  'NODE_ENV',
  'APP_ENV',
];

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function prepareIsolatedPaymentEnv() {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.UPSTASH_REDIS_REST_URL = '';
  process.env.UPSTASH_REDIS_REST_TOKEN = '';
  process.env.PAYMENT_SERVICE_URL = 'https://payments.example.test';
  process.env.PAYMENT_SERVICE_SHARED_SECRET = '';
  process.env.FLUTTERWAVE_ENABLED = 'true';
  process.env.NODE_ENV = 'development';
  process.env.APP_ENV = 'development';
  return snapshot;
}

function mockReq() {
  return {
    headers: {},
    ip: '127.0.0.1',
    get() {
      return '';
    },
  };
}

function installCheckoutFetch() {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          provider: 'flutterwave',
          reference: 'REF-flutterwave',
          checkoutUrl: 'https://checkout.example.test/flutterwave',
        };
      },
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}

async function importSecurePayments(caseName) {
  const url = new URL('../../src/services/securePayments.service.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function importPaymentServiceClient(caseName) {
  const url = new URL('../../src/services/paymentServiceClient.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test('local payment-service URLs are normalized to HTTP before checkout', async () => {
  const envSnapshot = prepareIsolatedPaymentEnv();
  const previousFetch = globalThis.fetch;
  const calls = [];

  process.env.NODE_ENV = 'development';
  process.env.APP_ENV = 'development';
  process.env.PAYMENT_SERVICE_URL = 'https://localhost:5001/';
  process.env.PAYMENT_SERVICE_SHARED_SECRET = '';

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          provider: 'flutterwave',
          reference: 'REF-local',
          checkoutUrl: 'https://checkout.example.test/flutterwave',
        };
      },
    };
  };

  try {
    const { createCheckout } = await importPaymentServiceClient('local-url-normalization');
    await createCheckout({
      orderId: 'order_local',
      userId: 'user_local',
      planId: 'coins_30',
      productType: 'coins',
      productId: 'coins_30',
      countryCode: 'US',
      currency: 'USD',
      amount: 0.09,
      productName: '30 coins',
      customerEmail: 'member@example.test',
      customerName: 'Member',
      clientRetries: 0,
    });

    assert.equal(calls[0].url, 'http://localhost:5001/api/payments/create');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(envSnapshot);
  }
});

test('US coin checkout sends Flutterwave as the primary provider', async () => {
  const envSnapshot = prepareIsolatedPaymentEnv();
  const fetchMock = installCheckoutFetch();
  try {
    const { createSecurePaymentSession } = await importSecurePayments('us-coin-routing');
    const checkout = await createSecurePaymentSession({
      userId: 'user_test_us',
      productType: 'coins',
      productId: 'coins_30',
      countryCode: 'US',
      customerEmail: 'member@example.test',
      customerName: 'Member',
      req: mockReq(),
    });

    assert.equal(checkout.provider, 'flutterwave');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal('provider' in fetchMock.calls[0].body, false);
    assert.equal('primaryProvider' in fetchMock.calls[0].body, false);
    assert.equal('fallbackProvider' in fetchMock.calls[0].body, false);
    assert.equal(fetchMock.calls[0].body.countryCode, 'US');
    assert.equal(fetchMock.calls[0].body.currency, 'USD');
    assert.equal(fetchMock.calls[0].body.inlineCheckout, true);
  } finally {
    fetchMock.restore();
    restoreEnv(envSnapshot);
  }
});

test('African coin checkout sends Flutterwave without fallback', async () => {
  const envSnapshot = prepareIsolatedPaymentEnv();
  const fetchMock = installCheckoutFetch();
  try {
    const { createSecurePaymentSession } = await importSecurePayments('ng-coin-routing');
    const checkout = await createSecurePaymentSession({
      userId: 'user_test_ng',
      productType: 'coins',
      productId: 'tokens_30',
      countryCode: 'NG',
      customerEmail: 'member@example.test',
      customerName: 'Member',
      req: mockReq(),
    });

    assert.equal(checkout.provider, 'flutterwave');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal('provider' in fetchMock.calls[0].body, false);
    assert.equal('primaryProvider' in fetchMock.calls[0].body, false);
    assert.equal('fallbackProvider' in fetchMock.calls[0].body, false);
    assert.equal(fetchMock.calls[0].body.countryCode, 'NG');
    assert.equal(fetchMock.calls[0].body.currency, 'NGN');
    assert.equal(fetchMock.calls[0].body.inlineCheckout, true);
  } finally {
    fetchMock.restore();
    restoreEnv(envSnapshot);
  }
});

test('coin checkout can request a hosted Flutterwave payment link', async () => {
  const envSnapshot = prepareIsolatedPaymentEnv();
  const fetchMock = installCheckoutFetch();
  try {
    const { createSecurePaymentSession } = await importSecurePayments('hosted-coin-link');
    const checkout = await createSecurePaymentSession({
      userId: 'user_hosted_coin',
      productType: 'coins',
      productId: 'coins_30',
      countryCode: 'US',
      customerEmail: 'member@example.test',
      customerName: 'Member',
      inlineCheckout: false,
      req: mockReq(),
    });

    assert.equal(checkout.provider, 'flutterwave');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.inlineCheckout, false);
    assert.equal(checkout.checkoutUrl, 'https://checkout.example.test/flutterwave');
  } finally {
    fetchMock.restore();
    restoreEnv(envSnapshot);
  }
});
