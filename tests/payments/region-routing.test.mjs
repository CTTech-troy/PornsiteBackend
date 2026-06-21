import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAfricanCountry,
  resolvePaymentProvider,
  resolveCheckoutCountry,
} from '../../src/services/paymentRegion.service.js';

test('African countries route to Flutterwave', () => {
  assert.equal(resolvePaymentProvider({ countryCode: 'NG' }), 'flutterwave');
  assert.equal(resolvePaymentProvider({ countryCode: 'KE' }), 'flutterwave');
  assert.equal(resolvePaymentProvider({ countryCode: 'ZA' }), 'flutterwave');
});

test('Non-African countries route to Flutterwave', () => {
  assert.equal(resolvePaymentProvider({ countryCode: 'US' }), 'flutterwave');
  assert.equal(resolvePaymentProvider({ countryCode: 'GB' }), 'flutterwave');
});

test('Billing country does not change the Flutterwave-only provider', () => {
  assert.equal(resolvePaymentProvider({ countryCode: 'US', billingCountry: 'NG' }), 'flutterwave');
  assert.equal(resolvePaymentProvider({ countryCode: 'NG', billingCountry: 'US' }), 'flutterwave');
});

test('isAfricanCountry helper', () => {
  assert.equal(isAfricanCountry('NG'), true);
  assert.equal(isAfricanCountry('US'), false);
});

test('resolveCheckoutCountry priority', () => {
  assert.equal(resolveCheckoutCountry({ billingCountry: 'GH', countryCode: 'US', ipCountry: 'CA' }), 'GH');
  assert.equal(resolveCheckoutCountry({ countryCode: 'FR', ipCountry: 'NG' }), 'FR');
});
