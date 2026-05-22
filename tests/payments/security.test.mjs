import test from 'node:test';
import assert from 'node:assert/strict';

test('gift catalog static fallback has positive costs', async () => {
  const { getGiftCatalog } = await import('../../src/services/coinWallet.service.js');
  const gifts = await getGiftCatalog();
  assert.ok(Array.isArray(gifts));
  assert.ok(gifts.length >= 1);
  for (const gift of gifts) {
    assert.ok(gift.coinCost > 0 || gift.price > 0);
  }
});

test('resolveGiftCost rejects unknown gift id', async () => {
  const { resolveGiftCost } = await import('../../src/services/coinWallet.service.js');
  await assert.rejects(() => resolveGiftCost('not_a_real_gift_xyz'));
});

test('payment gateway rejects skipped signatures messaging', async () => {
  const { verifyWebhookSignature } = await import('../../src/services/paymentGateway.service.js');
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.PAYSTACK_SECRET_KEY = '';
  try {
    const result = verifyWebhookSignature('paystack', {
      get: () => '',
      body: {},
    });
    assert.equal(result.valid, false);
  } finally {
    process.env.NODE_ENV = prev;
  }
});
