import {
  getBooleanSetting,
  getNumberSetting,
} from './platformSettings.service.js';

function envBoolean(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export async function getPaymentGatewayConfig() {
  const [
    flutterwaveEnabled,
    maxRetries,
    retryDelayMs,
    timeoutMs,
  ] = await Promise.all([
    getBooleanSetting('flutterwave_enabled', true),
    getNumberSetting('payment_retry_limit', 2),
    getNumberSetting('payment_retry_delay_ms', 750),
    getNumberSetting('payment_timeout_ms', 20000),
  ]);

  return {
    primary: 'flutterwave',
    fallback: '',
    flutterwaveEnabled: envBoolean('FLUTTERWAVE_ENABLED', flutterwaveEnabled),
    maxRetries: Math.max(0, Math.min(5, envNumber('PAYMENT_MAX_RETRIES', maxRetries) || 2)),
    retryDelayMs: Math.max(100, envNumber('PAYMENT_RETRY_DELAY_MS', retryDelayMs) || 750),
    timeoutMs: Math.max(5000, envNumber('PAYMENT_REQUEST_TIMEOUT_MS', timeoutMs) || 20000),
  };
}

export async function resolveCheckoutProviders() {
  const config = await getPaymentGatewayConfig();

  return {
    ...config,
    primary: config.flutterwaveEnabled ? 'flutterwave' : '',
    fallback: '',
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
