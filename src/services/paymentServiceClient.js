import crypto from 'crypto';

/**
 * paymentServiceClient.js
 *
 * HTTP client for the C# payment service.
 * All payment checkout creation is delegated here. The payment-service is
 * Flutterwave-only, so provider selection and fallback are not handled here.
 *
 * Environment variable:
 *   PAYMENT_SERVICE_URL  — base URL of the payment service
 *     Production: https://pornsite-paymentsystem-1.onrender.com
 *
 * The backend and payment service are fully independent:
 *   - The backend calls this client only for checkout creation.
 *   - Webhook handling stays in the backend (payment providers POST to it).
 *   - Either service can be down without crashing the other.
 */

const PRODUCTION_PAYMENT_SERVICE_URL = 'https://pornsite-paymentsystem-1.onrender.com';
const _rawUrl =
  process.env.PAYMENT_SERVICE_URL ||
  process.env.PAYMENT_API_URL ||
  process.env.PROD_PAYMENT_SERVICE_URL ||
  process.env.PROD_PAYMENT_API_URL;

function isProductionRuntime() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const appEnv = String(process.env.APP_ENV || '').toLowerCase();
  return nodeEnv === 'production' || appEnv === 'production';
}

function normalizePaymentServiceUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const isLocalHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]';

    if (!isProductionRuntime() && isLocalHost) {
      url.protocol = 'http:';
      if (host === '0.0.0.0' || host === '::1' || host === '[::1]') {
        url.hostname = '127.0.0.1';
      }
      if (!url.port) url.port = '5001';
    }

    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

// Warn loudly in production if the env var is missing.

if (!_rawUrl && process.env.NODE_ENV === 'production' && process.env.PAYMENT_SERVICE_STRICT_URL === 'true') {
  console.error(
    '[paymentService] ❌ PAYMENT_SERVICE_URL is not set.\n' +
    '   All checkout requests will fail.\n' +
    '   Set PAYMENT_SERVICE_URL to your payment service URL in the Render env vars.'
  );
}

if (!_rawUrl && process.env.NODE_ENV === 'production') {
  console.error(
    '[paymentService] PAYMENT_SERVICE_URL is not set.\n' +
    `   Falling back to ${PRODUCTION_PAYMENT_SERVICE_URL}.\n` +
    '   Set PAYMENT_SERVICE_URL explicitly in the Render env vars.'
  );
}

const PAYMENT_SERVICE_URL = normalizePaymentServiceUrl(
  _rawUrl ||
  PRODUCTION_PAYMENT_SERVICE_URL
);
if (_rawUrl && PAYMENT_SERVICE_URL !== String(_rawUrl).trim().replace(/\/+$/, '')) {
  console.info(`[paymentService] Normalized PAYMENT_SERVICE_URL to ${PAYMENT_SERVICE_URL}.`);
}
const PAYMENT_SERVICE_SHARED_SECRET = (process.env.PAYMENT_SERVICE_SHARED_SECRET || '').trim();

const CHECKOUT_TIMEOUT_MS       = 20_000;
const HEALTH_TIMEOUT_MS         =  5_000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000; // Render free-tier cold starts take up to 60s
const CHECKOUT_RETRY_STATUSES   = new Set([408, 425, 429, 500, 502, 503, 504]);

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const base = Math.max(250, envInt('PAYMENT_SERVICE_CLIENT_RETRY_DELAY_MS', 750));
  return Math.min(5000, base * Math.max(1, attempt));
}

function checkoutServiceError(message, { status = null, code = null, retryable = false } = {}) {
  const error = new Error(message);
  if (status != null) error.status = status;
  if (code) error.code = code;
  error.retryable = retryable;
  return error;
}

function canonicalCheckoutPayload(payload, timestamp) {
  return [
    String(timestamp || ''),
    String(payload.orderId || ''),
    String(payload.userId || ''),
    String(payload.productType || 'coins'),
    String(payload.productId || payload.planId || ''),
    Number(payload.amount || 0).toFixed(2),
    String(payload.currency || 'USD').toUpperCase(),
  ].join('\n');
}

function signedCheckoutHeaders(payload) {
  if (!PAYMENT_SERVICE_SHARED_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PAYMENT_SERVICE_SHARED_SECRET is required in production.');
    }
    return {};
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', PAYMENT_SERVICE_SHARED_SECRET)
    .update(canonicalCheckoutPayload(payload, timestamp))
    .digest('hex');

  return {
    'X-Payment-Service-Timestamp': String(timestamp),
    'X-Payment-Service-Signature': signature,
  };
}

// ---------------------------------------------------------------------------
// createCheckout
// ---------------------------------------------------------------------------

/**
 * Ask the payment service to create a checkout session.
 *
 * @param {{
 *   orderId:        string   — backend-generated payment intent key
 *   userId:         string
 *   planId:         string   — coin package id for legacy payment-service contract
 *   productType?:   string   — "coins"
 *   productId?:     string
 *   countryCode:    string   — ISO-3166-1 alpha-2, e.g. "NG" | "US"
 *   currency:       string   — "NGN" | "USD"
 *   amount:         number
 *   productName:    string
 *   customerEmail:  string
 *   customerName:   string
 * }} params
 *
 * @returns {Promise<{ provider: string, checkoutUrl: string, reference: string }>}
 * @throws  {Error} with a user-facing message on failure, timeout, or unreachable service
 */
async function createCheckoutOnce(params) {
  const url = `${PAYMENT_SERVICE_URL}/api/payments/create`;
  const timeoutMs = Math.max(5000, Number(params.timeoutMs || CHECKOUT_TIMEOUT_MS));
  const payload = {
    orderId:       params.orderId       ?? '',
    userId:        params.userId        ?? '',
    planId:        params.planId        ?? '',
    productType:   params.productType   ?? 'coins',
    productId:     params.productId     ?? params.planId ?? '',
    maxRetries: Number(params.maxRetries || 0),
    retryDelayMs: Number(params.retryDelayMs || 0),
    countryCode:   params.countryCode   ?? '',
    currency:      params.currency      ?? 'USD',
    amount:        params.amount        ?? 0,
    productName:   params.productName   ?? '',
    customerEmail: params.customerEmail ?? '',
    customerName:  params.customerName  ?? 'Member',
    customerPhone: params.customerPhone ?? '',
    inlineCheckout: Boolean(params.inlineCheckout),
    metadata:      params.metadata      ?? {},
  };
  const requestBody = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', ...signedCheckoutHeaders(payload) };

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw checkoutServiceError('Payment service timed out - please try again shortly.', {
        code: 'PAYMENT_SERVICE_TIMEOUT',
        retryable: true,
      });
    }
    throw checkoutServiceError(
      `Payment service is unreachable (${PAYMENT_SERVICE_URL}). ` +
      `Ensure it is running and PAYMENT_SERVICE_URL is set correctly.`,
      { code: 'PAYMENT_SERVICE_UNREACHABLE', retryable: true },
    );
  }

  // Parse response body — guard against non-JSON (HTML error pages etc.)
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw checkoutServiceError(`Payment service returned an invalid response (HTTP ${response.status}).`, {
      status: response.status,
      code: 'PAYMENT_SERVICE_INVALID_RESPONSE',
      retryable: CHECKOUT_RETRY_STATUSES.has(response.status),
    });
  }

  if (!response.ok) {
    const msg =
      responseBody?.detail ??
      responseBody?.message ??
      responseBody?.title ??
      `Payment service error (HTTP ${response.status}).`;
    throw checkoutServiceError(msg, {
      status: response.status,
      code: 'PAYMENT_SERVICE_HTTP_ERROR',
      retryable: CHECKOUT_RETRY_STATUSES.has(response.status),
    });
  }

  if (!responseBody?.provider || !responseBody?.reference) {
    throw new Error('Payment service returned an incomplete checkout response.');
  }

  const isFlutterwaveInline = responseBody.provider === 'flutterwave' && responseBody.flutterwave;
  if (!isFlutterwaveInline && !responseBody.checkoutUrl) {
    throw new Error('Payment service returned an incomplete checkout response.');
  }

  return {
    provider:    responseBody.provider,
    checkoutUrl: responseBody.checkoutUrl || null,
    reference:   responseBody.reference,
    flutterwave: responseBody.flutterwave || null,
    fallbackUsed: responseBody.fallbackUsed === true,
    retryCount: Number(responseBody.retryCount || 0),
    attemptedProviders: Array.isArray(responseBody.attemptedProviders) ? responseBody.attemptedProviders : [],
    gatewayLog: responseBody.gatewayLog || null,
  };
}

function isRetryableCheckoutError(error) {
  if (error?.retryable === true) return true;
  if (CHECKOUT_RETRY_STATUSES.has(Number(error?.status))) return true;
  return /timed out|unreachable|temporarily unavailable|invalid response|bad gateway|service unavailable/i
    .test(String(error?.message || ''));
}

export async function createCheckout(params) {
  const maxClientRetries = Math.max(
    0,
    Math.min(3, Number(params.clientRetries ?? envInt('PAYMENT_SERVICE_CLIENT_RETRIES', 2))),
  );
  let lastError = null;

  for (let attempt = 0; attempt <= maxClientRetries; attempt += 1) {
    try {
      return await createCheckoutOnce(params);
    } catch (error) {
      lastError = error;
      if (attempt >= maxClientRetries || !isRetryableCheckoutError(error)) {
        throw error;
      }
      await sleep(retryDelay(attempt + 1));
    }
  }

  throw lastError || checkoutServiceError('Payment service checkout failed.', {
    code: 'PAYMENT_SERVICE_FAILED',
  });
}

// ---------------------------------------------------------------------------
// pingPaymentService
// ---------------------------------------------------------------------------

/**
 * Non-throwing health check for the payment service.
 * Used at backend startup and in health-check routes.
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function pingPaymentService({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const url = `${PAYMENT_SERVICE_URL}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      return { ok: true, detail: `reachable at ${PAYMENT_SERVICE_URL}` };
    }
    return { ok: false, detail: `HTTP ${res.status} from ${PAYMENT_SERVICE_URL}` };
  } catch (err) {
    return { ok: false, detail: `${err.message} (${PAYMENT_SERVICE_URL})` };
  }
}

export async function getGatewayHealth({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const url = `${PAYMENT_SERVICE_URL}/api/payments/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: 'degraded', providers: [], detail: body?.detail || `HTTP ${res.status}` };
    }
    return {
      ok: body?.status === 'ok',
      status: body?.status || 'unknown',
      primary: body?.primary || 'flutterwave',
      fallback: body?.fallback || '',
      providers: body?.providers || [],
    };
  } catch (err) {
    return { ok: false, status: 'unreachable', providers: [], detail: err.message };
  }
}

export { STARTUP_HEALTH_TIMEOUT_MS };
