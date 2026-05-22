function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export function logPaymentEvent(level, event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    scope: 'payments',
    event,
    ...details,
  };
  const line = `[payments] ${event} ${safeJson(payload)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
