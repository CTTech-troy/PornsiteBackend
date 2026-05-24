import {
  getBooleanSetting,
  getNumberSetting,
  getStringSetting,
} from './platformSettings.service.js';

function normalizeProvider(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'flw') return 'flutterwave';
  if (name === 'flutterwave' || name === 'paystack') return name;
  if (name === 'none') return '';
  return '';
}

export async function getPaymentGatewayConfig() {
  const [
    primary,
    fallback,
    flutterwaveEnabled,
    paystackEnabled,
    maxRetries,
    retryDelayMs,
    timeoutMs,
  ] = await Promise.all([
    getStringSetting('payment_gateway_primary', 'flutterwave'),
    getStringSetting('payment_gateway_fallback', 'paystack'),
    getBooleanSetting('flutterwave_enabled', true),
    getBooleanSetting('paystack_enabled', true),
    getNumberSetting('payment_retry_limit', 2),
    getNumberSetting('payment_retry_delay_ms', 750),
    getNumberSetting('payment_timeout_ms', 20000),
  ]);

  const normalizedFallback = normalizeProvider(fallback);

  return {
    primary: normalizeProvider(primary) || 'flutterwave',
    fallback: normalizedFallback || 'paystack',
    flutterwaveEnabled,
    paystackEnabled,
    maxRetries: Math.max(0, Math.min(5, Number(maxRetries) || 2)),
    retryDelayMs: Math.max(100, Number(retryDelayMs) || 750),
    timeoutMs: Math.max(5000, Number(timeoutMs) || 20000),
  };
}

export async function resolveCheckoutProviders({
  explicitProvider = '',
} = {}) {
  const config = await getPaymentGatewayConfig();
  const requested = normalizeProvider(explicitProvider);

  if (requested === 'flutterwave' && config.flutterwaveEnabled) {
    const fallback = config.paystackEnabled && config.fallback !== 'flutterwave'
      ? config.fallback
      : '';
    return { ...config, primary: 'flutterwave', fallback, allowFallback: Boolean(fallback) };
  }

  if (requested === 'paystack' && config.paystackEnabled) {
    const fallback = config.flutterwaveEnabled && config.fallback !== 'paystack'
      ? 'flutterwave'
      : '';
    return { ...config, primary: 'paystack', fallback, allowFallback: Boolean(fallback) };
  }

  let primary = config.primary === 'manual'
    ? (config.flutterwaveEnabled ? 'flutterwave' : (config.paystackEnabled ? 'paystack' : ''))
    : config.primary;

  if (primary === 'flutterwave' && !config.flutterwaveEnabled) {
    primary = config.paystackEnabled ? 'paystack' : '';
  } else if (primary === 'paystack' && !config.paystackEnabled) {
    primary = config.flutterwaveEnabled ? 'flutterwave' : '';
  }

  let fallback = config.fallback;
  if (fallback === 'paystack' && !config.paystackEnabled) fallback = '';
  if (fallback === 'flutterwave' && !config.flutterwaveEnabled) fallback = '';
  if (fallback === primary) fallback = '';

  return {
    ...config,
    primary,
    fallback,
    allowFallback: Boolean(fallback),
  };
}

export function userFacingPaymentError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('unreachable') || message.includes('timed out') || message.includes('502'))
    return 'Payment is temporarily unavailable. Please try again in a moment.';
  if (message.includes('disabled') || message.includes('not configured'))
    return 'Payments are temporarily unavailable. Please contact support if this continues.';
  if (message.includes('fraud') || message.includes('review'))
    return 'Your payment session requires review. Please try again later or contact support.';
  return 'We could not start checkout. Please try again.';
}
