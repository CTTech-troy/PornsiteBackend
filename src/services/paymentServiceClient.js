import crypto from 'crypto';

/**
 * paymentServiceClient.js
 *
 * HTTP client for the C# payment service.
 * All payment checkout creation is delegated here — Paystack, Flutterwave, Stripe
 * credentials are needed in this module.
 *
 * Environment variable:
 *   PAYMENT_SERVICE_URL  — base URL of the payment service
 *     Production: https://payments.xstreamvideos.site
 *
 * The backend and payment service are fully independent:
 *   - The backend calls this client only for checkout creation.
 *   - Webhook handling stays in the backend (payment providers POST to it).
 *   - Either service can be down without crashing the other.
 */

const PRODUCTION_PAYMENT_SERVICE_URL = 'https://payments.xstreamvideos.site';
const _rawUrl = process.env.PAYMENT_SERVICE_URL;

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

const PAYMENT_SERVICE_URL = (
  _rawUrl ||
  PRODUCTION_PAYMENT_SERVICE_URL
).replace(/\/$/, '');
const PAYMENT_SERVICE_SHARED_SECRET = (process.env.PAYMENT_SERVICE_SHARED_SECRET || '').trim();

const CHECKOUT_TIMEOUT_MS       = 20_000;
const HEALTH_TIMEOUT_MS         =  5_000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000; // Render free-tier cold starts take up to 60s

function canonicalCheckoutPayload(payload, timestamp) {
  return [
    String(timestamp || ''),
    String(payload.orderId || ''),
    String(payload.userId || ''),
    String(payload.productType || 'membership'),
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
 *   orderId:        string   — "{userId}_{planId}_{timestamp}"
 *   userId:         string
 *   planId:         string
 *   productType?:   string   — "membership" | "coins"
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
export async function createCheckout(params) {
  const url = `${PAYMENT_SERVICE_URL}/api/payments/create`;
  const timeoutMs = Math.max(5000, Number(params.timeoutMs || CHECKOUT_TIMEOUT_MS));
  const payload = {
    orderId:       params.orderId       ?? '',
    userId:        params.userId        ?? '',
    planId:        params.planId        ?? '',
    productType:   params.productType   ?? 'membership',
    productId:     params.productId     ?? params.planId ?? '',
    provider:      params.provider      ?? '',
    primaryProvider: params.primaryProvider ?? params.provider ?? '',
    fallbackProvider: params.fallbackProvider ?? '',
    allowFallback: params.allowFallback !== false,
    flutterwaveEnabled: params.flutterwaveEnabled !== false,
    paystackEnabled: params.paystackEnabled !== false,
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
      throw new Error('Payment service timed out — please try again shortly.');
    }
    throw new Error(
      `Payment service is unreachable (${PAYMENT_SERVICE_URL}). ` +
      `Ensure it is running and PAYMENT_SERVICE_URL is set correctly.`
    );
  }

  // Parse response body — guard against non-JSON (HTML error pages etc.)
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error(`Payment service returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const msg =
      responseBody?.detail ??
      responseBody?.message ??
      responseBody?.title ??
      `Payment service error (HTTP ${response.status}).`;
    throw new Error(msg);
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
      fallback: body?.fallback || 'paystack',
      providers: body?.providers || [],
    };
  } catch (err) {
    return { ok: false, status: 'unreachable', providers: [], detail: err.message };
  }
}

export { STARTUP_HEALTH_TIMEOUT_MS };
