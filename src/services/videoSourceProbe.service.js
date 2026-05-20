const PROBE_TIMEOUT_MS = 8000;
const probeCache = new Map();

function parseFrameAncestors(csp) {
  const match = String(csp || '').match(/frame-ancestors\s+([^;]+)/i);
  return match ? match[1].trim().toLowerCase() : '';
}

function blocksEmbedding(headers) {
  const xfo = String(headers.get('x-frame-options') || '').trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return true;
  const csp = String(headers.get('content-security-policy') || '');
  const ancestors = parseFrameAncestors(csp);
  if (ancestors === "'none'" || ancestors === 'none') return true;
  return false;
}

/**
 * HEAD probe for official embed URLs. Returns { ok, reason }.
 */
export async function probeEmbedUrl(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return { ok: false, reason: 'empty_url' };

  const cached = probeCache.get(normalized);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
    return cached.result;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(normalized, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'LetStream-VideoProbe/1.0' },
    });
    if (!res.ok) {
      const result = { ok: false, reason: `http_${res.status}` };
      probeCache.set(normalized, { ts: Date.now(), result });
      return result;
    }
    if (blocksEmbedding(res.headers)) {
      const result = { ok: false, reason: 'frame_blocked' };
      probeCache.set(normalized, { ts: Date.now(), result });
      return result;
    }
    const result = { ok: true, reason: '' };
    probeCache.set(normalized, { ts: Date.now(), result });
    return result;
  } catch (err) {
    const result = { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
    probeCache.set(normalized, { ts: Date.now(), result });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function validateEmbedWithProbe(embedUrl) {
  const probe = await probeEmbedUrl(embedUrl);
  if (probe.ok) {
    return {
      playable: true,
      sourceType: 'official_embed',
      embedAllowed: true,
      validationStatus: 'playable',
      playbackUrl: embedUrl,
      reason: '',
    };
  }
  return {
    playable: false,
    sourceType: 'blocked_embed',
    embedAllowed: false,
    validationStatus: 'probe_failed',
    playbackUrl: '',
    reason: `Embed cannot be framed: ${probe.reason}`,
  };
}
