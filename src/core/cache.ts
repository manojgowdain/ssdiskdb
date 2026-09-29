/**
 * Bounded LRU cache.
 *
 * Stores decoded values keyed by their data key, along with the record's
 * expiresAt so the cache can never return an already-expired entry. The cache
 * is strictly bounded: once it exceeds maxEntries the least-recently-used
 * entry is evicted. It is a performance aid only - correctness never depends
 * on it.
 */

export interface CacheEntry {
  value: any;
  expiresAt?: number;
}

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  ttl?: number;
}

export class LRUCache {
  private readonly maxEntries: number;
  private readonly defaultTtl: number;
  private enabled: boolean;
  private map = new Map<string, CacheEntry>();

  constructor(options: CacheOptions = {}) {
    this.enabled = options.enabled !== false;
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.defaultTtl = Math.max(0, options.ttl ?? 0);
  }

  setEnabled(v: boolean): void { this.enabled = v; }

  get(key: string): CacheEntry | undefined {
    if (!this.enabled) return undefined;
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // Expired entries are never returned; remove them.
    if (hit.expiresAt !== undefined && hit.expiresAt <= Date.now()) {
      this.invalidate(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, entry: CacheEntry): void {
    if (!this.enabled) return;
    // Never cache expired data.
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) return;
    this.map.delete(key);
    const expiresAt = this.defaultTtl > 0
      ? Math.min(entry.expiresAt ?? Number.POSITIVE_INFINITY, Date.now() + this.defaultTtl)
      : entry.expiresAt;
    this.map.set(key, { ...entry, expiresAt });
    this.evict();
  }

  invalidate(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number { return this.map.size; }
  get isEnabled(): boolean { return this.enabled; }

  private evict(): void {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
