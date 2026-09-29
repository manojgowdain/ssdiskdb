/**
 * Lightweight runtime metrics.
 *
 * These are pure counters updated synchronously on the hot path. No timers,
 * no scans, no allocations. `stats()` snapshots them cheaply.
 */

export interface StatsSnapshot {
  reads: number;
  writes: number;
  deletes: number;
  expiredKeys: number;
  cacheHits: number;
  cacheMisses: number;
  operationsPerSecond: number;
  activeConnections: number;
  bytesRead: number;
  bytesWritten: number;
  ttlCleanupRuns: number;
  ttlCleanupKeysDeleted: number;
}

export class Metrics {
  reads = 0;
  writes = 0;
  deletes = 0;
  expiredKeys = 0;
  cacheHits = 0;
  cacheMisses = 0;
  bytesRead = 0;
  bytesWritten = 0;
  ttlCleanupRuns = 0;
  ttlCleanupKeysDeleted = 0;

  private start = Date.now();
  private opCount = 0;
  private lastSecond = 0;
  private opsInSecond = 0;

  recordRead(bytes = 0): void {
    this.reads++;
    this.opCount++;
    this.bytesRead += bytes;
    this._tick();
  }

  recordWrite(bytes = 0): void {
    this.writes++;
    this.opCount++;
    this.bytesWritten += bytes;
    this._tick();
  }

  recordDelete(): void {
    this.deletes++;
    this.opCount++;
    this._tick();
  }

  recordCacheHit(): void { this.cacheHits++; }
  recordCacheMiss(): void { this.cacheMisses++; }
  recordExpired(): void { this.expiredKeys++; }
  recordCleanup(keysDeleted: number): void {
    this.ttlCleanupRuns++;
    this.ttlCleanupKeysDeleted += keysDeleted;
  }

  private _tick(): void {
    const now = Date.now();
    const second = Math.floor(now / 1000);
    if (second !== this.lastSecond) {
      this.lastSecond = second;
      this.opsInSecond = 0;
    }
    this.opsInSecond++;
  }

  snapshot(activeConnections = 0): StatsSnapshot {
    return {
      reads: this.reads,
      writes: this.writes,
      deletes: this.deletes,
      expiredKeys: this.expiredKeys,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      operationsPerSecond: this.opsInSecond,
      activeConnections,
      bytesRead: this.bytesRead,
      bytesWritten: this.bytesWritten,
      ttlCleanupRuns: this.ttlCleanupRuns,
      ttlCleanupKeysDeleted: this.ttlCleanupKeysDeleted
    };
  }
}