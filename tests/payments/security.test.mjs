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
