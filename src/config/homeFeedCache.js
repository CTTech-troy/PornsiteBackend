import { getPathSafeVideoId } from '../utils/videoPathId.js';

const store = new Map();
const MAX_KEYS = 1200;

function touchKeysForRow(row) {
  if (!row || typeof row !== 'object') return [];
  const keys = new Set();
  const rawId = row.id != null ? String(row.id).trim() : '';
  if (rawId) {
    keys.add(rawId);
    keys.add(getPathSafeVideoId(rawId));
  }
  const src = row.videoSrc || row.url;
  if (src && typeof src === 'string' && src.startsWith('http')) {
    keys.add(getPathSafeVideoId(src));
    const slug = src.replace(/^.*\//, '').split('?')[0];
    if (slug) keys.add(slug);
  }
  return [...keys].filter(Boolean);
}

export function ingestHomeFeedVideos(items) {
  if (!Array.isArray(items)) return;
  for (const row of items) {
    if (!row) continue;
    for (const k of touchKeysForRow(row)) {
      store.set(k, row);
    }
  }
  while (store.size > MAX_KEYS) {
    const first = store.keys().next().value;
    store.delete(first);
  }
}

export function lookupHomeFeedRow(id) {
  if (id == null || id === '') return null;
  const k = String(id).trim();
  return store.get(k) || store.get(getPathSafeVideoId(k)) || null;
}
