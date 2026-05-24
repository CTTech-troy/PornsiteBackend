const AFRICAN_COUNTRY_CODES = new Set([
  'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CG', 'CD', 'CI',
  'DJ', 'EG', 'GQ', 'ER', 'SZ', 'ET', 'GA', 'GM', 'GH', 'GN', 'GW', 'KE', 'LS', 'LR',
  'LY', 'MG', 'MW', 'ML', 'MR', 'MU', 'MA', 'MZ', 'NA', 'NE', 'NG', 'RW', 'ST', 'SN',
  'SC', 'SL', 'SO', 'ZA', 'SS', 'SD', 'TZ', 'TG', 'TN', 'UG', 'EH', 'ZM', 'ZW',
]);

export function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

export function isAfricanCountry(countryCode) {
  const code = normalizeCountryCode(countryCode);
  return code ? AFRICAN_COUNTRY_CODES.has(code) : false;
}

export function countryFromRequest(req) {
  const headers = req?.headers || {};
  const candidates = [
    headers['cf-ipcountry'],
    headers['x-vercel-ip-country'],
    headers['x-country-code'],
    headers['x-app-country'],
  ];
  for (const value of candidates) {
    const code = normalizeCountryCode(value);
    if (code && code !== 'XX' && code !== 'T1') return code;
  }
  return null;
}

/**
 * Legacy helper — prefer resolveCheckoutProviders() from paymentOrchestrator.service.js.
 * Defaults to Flutterwave as primary when no explicit provider is supplied.
 */
export function resolvePaymentProvider({
  countryCode = null,
  billingCountry = null,
  ipCountry = null,
  explicitProvider = null,
} = {}) {
  const requested = String(explicitProvider || '').trim().toLowerCase();
  if (requested === 'paystack' || requested === 'flutterwave' || requested === 'flw') {
    return requested === 'flw' ? 'flutterwave' : requested;
  }

  // Flutterwave is the default primary gateway across regions.
  return 'flutterwave';
}

export function resolveCheckoutCountry({
  countryCode = null,
  billingCountry = null,
  ipCountry = null,
} = {}) {
  return (
    normalizeCountryCode(billingCountry) ||
    normalizeCountryCode(countryCode) ||
    normalizeCountryCode(ipCountry) ||
    'US'
  );
}

export function paymentProviderLabel(provider) {
  const name = String(provider || '').toLowerCase();
  if (name === 'flutterwave' || name === 'flw') return 'Flutterwave';
  if (name === 'paystack') return 'Paystack';
  return name || 'Payment provider';
}
