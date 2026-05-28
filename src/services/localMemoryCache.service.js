function nowMs() {
  return Date.now();
}

class LruMemoryCache {
  constructor({ maxEntries = 500 } = {}) {
    this.maxEntries = Math.max(10, Number(maxEntries) || 500);
    this.entries = new Map();
    this.pending = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      pendingHits: 0,
    };
  }

  get(key) {
    const id = String(key);
    const entry = this.entries.get(id);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (entry.expiresAt <= nowMs()) {
      this.entries.delete(id);
      this.stats.misses += 1;
      return null;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.stats.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs) {
    const id = String(key);
    if (this.entries.has(id)) this.entries.delete(id);
    this.entries.set(id, {
      value,
      expiresAt: nowMs() + Math.max(1, Number(ttlMs) || 1),
      cachedAt: nowMs(),
    });
    this.stats.sets += 1;
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.stats.evictions += 1;
    }
    return value;
  }

  delete(key) {
    this.pending.delete(String(key));
    return this.entries.delete(String(key));
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
  }

  async wrap(key, loader, ttlMs) {
    const cached = this.get(key);
    if (cached != null) return cached;

    const id = String(key);
    if (this.pending.has(id)) {
      this.stats.pendingHits += 1;
      return this.pending.get(id);
    }

    const promise = Promise.resolve()
      .then(loader)
      .then((value) => this.set(id, value, ttlMs))
      .finally(() => this.pending.delete(id));
    this.pending.set(id, promise);
    return promise;
  }

  snapshot() {
    return {
      maxEntries: this.maxEntries,
      entries: this.entries.size,
      pending: this.pending.size,
      ...this.stats,
    };
  }
}

export const appMemoryCache = new LruMemoryCache({
  maxEntries: Number(process.env.LOCAL_MEMORY_CACHE_MAX_ENTRIES || 1000),
});

export function getLocalMemoryCacheDiagnostics() {
  return appMemoryCache.snapshot();
}
