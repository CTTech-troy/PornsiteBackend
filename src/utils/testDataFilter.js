const TEST_MARKER_RE = /(^|[._:\-\s@/+])(test|demo|sample|fake|sandbox|dummy)([._:\-\s@/+]|$)/i;
const TEST_FLAG_KEY_RE = /^(is_?)?(test|demo|sample|fake|sandbox|dummy)(_?(mode|data|record|payment))?$/i;
const TEST_MODE_KEY_RE = /^(env|environment|mode|payment_mode|provider_mode|account_type|record_type|data_type)$/i;

function hasTestMarker(value, key = '', depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || depth > 4) return false;

  if (typeof value === 'boolean') {
    return value === true && TEST_FLAG_KEY_RE.test(String(key || ''));
  }

  if (typeof value === 'number') return false;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return false;
    if (TEST_FLAG_KEY_RE.test(String(key || '')) && /^(true|1|yes|test|demo|sample|fake|sandbox|dummy)$/i.test(text)) return true;
    if (TEST_MODE_KEY_RE.test(String(key || '')) && /^(test|demo|sample|fake|sandbox|dummy)$/i.test(text)) return true;
    return TEST_MARKER_RE.test(text);
  }

  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasTestMarker(item, key, depth + 1, seen));
  }

  return Object.entries(value).some(([childKey, childValue]) => (
    hasTestMarker(childValue, childKey, depth + 1, seen)
  ));
}

export function isTestDataRecord(row = {}) {
  if (!row || typeof row !== 'object') return false;
  return [
    row.id,
    row.user_id,
    row.userId,
    row.creator_id,
    row.creatorId,
    row.email,
    row.user_email,
    row.userEmail,
    row.name,
    row.userName,
    row.provider_reference,
    row.providerReference,
    row.intent_key,
    row.orderKey,
    row.reference,
    row.transactionId,
    row.transaction_id,
    row.source_id,
    row.sourceId,
    row.metadata,
    row.product_snapshot,
    row.productSnapshot,
  ].some((value) => hasTestMarker(value));
}

export function filterProductionRecords(rows = []) {
  return Array.isArray(rows) ? rows.filter((row) => !isTestDataRecord(row)) : [];
}
