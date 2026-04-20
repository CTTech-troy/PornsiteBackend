/**
 * paymentServiceClient.js
 *
 * HTTP client for the C# payment service.
 * All payment checkout creation is delegated here — no Paystack/Monnify
 * credentials are needed in this module.
 *
 * Environment variable:
 *   PAYMENT_SERVICE_URL  — base URL of the payment service
 *     Local:      http://localhost:5001
 *     Production: https://your-payment-service.onrender.com
 *
 * The backend and payment service are fully independent:
 *   - The backend calls this client only for checkout creation.
 *   - Webhook handling stays in the backend (payment providers POST to it).
 *   - Either service can be down without crashing the other.
 */

const _rawUrl = process.env.PAYMENT_SERVICE_URL;

// Warn loudly in production if the env var is missing — a silent localhost
// fallback in production produces confusing "fetch failed" errors.
if (!_rawUrl && process.env.NODE_ENV === 'production') {
  console.error(
    '[paymentService] ❌ PAYMENT_SERVICE_URL is not set.\n' +
    '   All checkout requests will fail.\n' +
    '   Set PAYMENT_SERVICE_URL to your payment service URL in the Render env vars.'
  );
}

const PAYMENT_SERVICE_URL = (_rawUrl || 'http://localhost:5001').replace(/\/$/, '');

const CHECKOUT_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS   = 5_000;

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

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId:       params.orderId       ?? '',
        userId:        params.userId        ?? '',
        planId:        params.planId        ?? '',
        countryCode:   params.countryCode   ?? '',
        currency:      params.currency      ?? 'USD',
        amount:        params.amount        ?? 0,
        productName:   params.productName   ?? '',
        customerEmail: params.customerEmail ?? '',
        customerName:  params.customerName  ?? 'Member',
        customerPhone: params.customerPhone ?? '',
      }),
      signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS),
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
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Payment service returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    // ASP.NET problem details: { title, detail, message }
    const msg =
      body?.message ??
      body?.detail  ??
      body?.title   ??
      `Payment service error (HTTP ${response.status}).`;
    throw new Error(msg);
  }

  if (!body?.checkoutUrl || !body?.provider || !body?.reference) {
    throw new Error('Payment service returned an incomplete checkout response.');
  }

  return {
    provider:    body.provider,
    checkoutUrl: body.checkoutUrl,
    reference:   body.reference,
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
export async function pingPaymentService() {
  const url = `${PAYMENT_SERVICE_URL}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.ok) {
      return { ok: true, detail: `reachable at ${PAYMENT_SERVICE_URL}` };
    }
    return { ok: false, detail: `HTTP ${res.status} from ${PAYMENT_SERVICE_URL}` };
  } catch (err) {
    return { ok: false, detail: `${err.message} (${PAYMENT_SERVICE_URL})` };
  }
}
