import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

async function importPaymentGateway(caseName) {
  const url = new URL('../../src/services/paymentGateway.service.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function importCoinWallet(caseName) {
  const url = new URL('../../src/services/coinWallet.service.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function importPaymentHistory(caseName) {
  const url = new URL('../../src/services/paymentHistory.service.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function importTestDataFilter(caseName) {
  const url = new URL('../../src/utils/testDataFilter.js', import.meta.url);
  url.searchParams.set('case', `${caseName}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function disableSupabaseEnv() {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  return previous;
}

function mockWebhookReq(rawBody, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    rawBody,
    body: JSON.parse(rawBody),
    get(name) {
      return lower[String(name || '').toLowerCase()] || '';
    },
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('gift catalog static fallback has positive costs', async () => {
  const prevSupabase = disableSupabaseEnv();
  try {
    const { getGiftCatalog } = await importCoinWallet('gift-catalog-static');
    const gifts = await getGiftCatalog();
    assert.ok(Array.isArray(gifts));
    assert.ok(gifts.length >= 1);
    for (const gift of gifts) {
      assert.ok(gift.coinCost > 0 || gift.price > 0);
    }
  } finally {
    restoreEnv('SUPABASE_URL', prevSupabase.SUPABASE_URL);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevSupabase.SUPABASE_SERVICE_ROLE_KEY);
  }
});

test('coin package static fallback matches live coins_30 price', async () => {
  const prevSupabase = disableSupabaseEnv();
  try {
    const { getCoinPackage } = await importCoinWallet('coin-package-static');
    const pkg = await getCoinPackage('coins_30');
    assert.equal(pkg.id, 'coins_30');
    assert.equal(pkg.priceUsd, 0.09);
    assert.equal(pkg.priceNgn, 125);
    assert.equal(pkg.bonusCoins, 5);
    assert.equal(pkg.totalCoins, 35);
  } finally {
    restoreEnv('SUPABASE_URL', prevSupabase.SUPABASE_URL);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevSupabase.SUPABASE_SERVICE_ROLE_KEY);
  }
});

test('payment history uses paid amount for coin purchases instead of credited coins', async () => {
  const prevSupabase = disableSupabaseEnv();
  try {
    const { resolvePaymentHistoryAmountUsd } = await importPaymentHistory('coin-history-paid-amount');
    const walletPurchase = {
      amount: 35,
      currency: 'USD',
      metadata: {
        amountPaid: 0.09,
        currency: 'USD',
      },
    };

    assert.equal(resolvePaymentHistoryAmountUsd(walletPurchase, ['amount_usd', 'purchase_amount_usd', 'official_amount']), 0.09);
    assert.equal(resolvePaymentHistoryAmountUsd({
      amount: 35,
      currency: 'NGN',
      metadata: {
        amountPaid: 125,
        currency: 'NGN',
      },
    }, ['amount_usd', 'purchase_amount_usd', 'official_amount']), 125 / 1600);
    assert.equal(resolvePaymentHistoryAmountUsd({
      amount: 35,
      currency: 'NGN',
      metadata: {
        amountPaid: 125,
        priceUsd: 0.09,
        currency: 'NGN',
      },
    }, ['amount_usd', 'purchase_amount_usd', 'official_amount']), 0.09);
  } finally {
    restoreEnv('SUPABASE_URL', prevSupabase.SUPABASE_URL);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevSupabase.SUPABASE_SERVICE_ROLE_KEY);
  }
});

test('admin payment reporting excludes clearly marked test records', async () => {
  const { isTestDataRecord, filterProductionRecords } = await importTestDataFilter('payment-test-filter');
  const productionPayment = {
    id: 'pay_123',
    user_id: 'user_456',
    provider_reference: 'flw_live_123',
    metadata: { amountPaid: 0.09, currency: 'USD' },
  };
  const testPayment = {
    id: 'pay_test_123',
    user_id: 'user_test_us',
    provider_reference: 'sandbox-payment-1',
    metadata: { isTest: true, amountPaid: 35, currency: 'USD' },
  };

  assert.equal(isTestDataRecord(productionPayment), false);
  assert.equal(isTestDataRecord(testPayment), true);
  assert.deepEqual(filterProductionRecords([productionPayment, testPayment]), [productionPayment]);
});

test('resolveGiftCost rejects unknown gift id', async () => {
  const prevSupabase = disableSupabaseEnv();
  try {
    const { resolveGiftCost } = await importCoinWallet('gift-cost-static');
    await assert.rejects(() => resolveGiftCost('not_a_real_gift_xyz'));
  } finally {
    restoreEnv('SUPABASE_URL', prevSupabase.SUPABASE_URL);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', prevSupabase.SUPABASE_SERVICE_ROLE_KEY);
  }
});

test('payment gateway requires configured signatures in production', async () => {
  const prev = process.env.NODE_ENV;
  const prevPaystack = process.env.PAYSTACK_SECRET_KEY;
  process.env.NODE_ENV = 'production';
  process.env.PAYSTACK_SECRET_KEY = '';
  try {
    const { verifyWebhookSignature } = await importPaymentGateway('paystack-missing-secret');
    assert.throws(() => verifyWebhookSignature('paystack', {
      get: () => '',
      body: {},
    }), /PAYSTACK_SECRET_KEY is required in production/);
  } finally {
    restoreEnv('NODE_ENV', prev);
    restoreEnv('PAYSTACK_SECRET_KEY', prevPaystack);
  }
});

test('flutterwave webhook accepts HMAC flutterwave-signature', async () => {
  const prev = {
    nodeEnv: process.env.NODE_ENV,
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH,
  };
  const secret = 'test-flutterwave-webhook-secret';
  const rawBody = JSON.stringify({ event: 'charge.completed', data: { id: 123, status: 'successful' } });
  process.env.NODE_ENV = 'production';
  process.env.FLUTTERWAVE_WEBHOOK_HASH = secret;
  try {
    const { verifyWebhookSignature } = await importPaymentGateway('flutterwave-hmac');
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const result = verifyWebhookSignature('flutterwave', mockWebhookReq(rawBody, { 'flutterwave-signature': signature }));
    assert.equal(result.valid, true);
    assert.equal(result.skipped, false);
  } finally {
    restoreEnv('NODE_ENV', prev.nodeEnv);
    restoreEnv('FLUTTERWAVE_WEBHOOK_HASH', prev.webhookHash);
  }
});

test('flutterwave webhook accepts legacy verif-hash secret', async () => {
  const prev = {
    nodeEnv: process.env.NODE_ENV,
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH,
  };
  const secret = 'legacy-verif-hash-secret';
  const rawBody = JSON.stringify({ event: 'charge.completed', data: { id: 456, status: 'successful' } });
  process.env.NODE_ENV = 'production';
  process.env.FLUTTERWAVE_WEBHOOK_HASH = secret;
  try {
    const { verifyWebhookSignature } = await importPaymentGateway('flutterwave-verif-hash');
    const result = verifyWebhookSignature('flutterwave', mockWebhookReq(rawBody, { 'verif-hash': secret }));
    assert.equal(result.valid, true);
    assert.equal(result.skipped, false);
  } finally {
    restoreEnv('NODE_ENV', prev.nodeEnv);
    restoreEnv('FLUTTERWAVE_WEBHOOK_HASH', prev.webhookHash);
  }
});

test('flutterwave verification supports hosted checkout tx_ref fallback', async () => {
  const prev = {
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY,
  };
  const previousFetch = globalThis.fetch;
  const calls = [];
  process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-unit';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          status: 'success',
          data: {
            id: 987654,
            tx_ref: 'intent_key_123',
            status: 'successful',
            amount: 0.09,
            currency: 'USD',
            meta: {
              userId: 'user_123',
              productType: 'coins',
              productId: 'coins_30',
            },
          },
        };
      },
    };
  };

  try {
    const { verifyProviderTransaction } = await importPaymentGateway('flutterwave-txref');
    const verified = await verifyProviderTransaction('flutterwave', {
      reference: 'intent_key_123',
      orderKey: 'intent_key_123',
    });
    assert.equal(verified.reference, '987654');
    assert.equal(verified.orderKey, 'intent_key_123');
    assert.equal(verified.productType, 'coins');
    assert.equal(calls[0], 'https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=intent_key_123');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('FLUTTERWAVE_SECRET_KEY', prev.secretKey);
  }
});
