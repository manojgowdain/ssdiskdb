/**
 * TTL Engine
 *
 * A single, bounded background worker that periodically walks the ordered
 * expiration index (`ttl/<expiresAt>/<fullDataKey>`) and deletes records whose
 * `expiresAt` has already passed. It is the ONLY place that scans the index,
 * and it always stops as soon as the next index entry is in the future.
 *
 * Design constraints honored here:
 *   - No per-key timers. One interval timer total.
 *   - Bounded work per tick (cleanupBatchSize).
 *   - Yields to the event loop between batches.
 *   - Stops during close().
 *   - Uses unref() so it doesn't keep Node.js alive on its own.
 */

import type { Level } from "level";
import { ttlIndexRange, ttlIndexKey } from "./keys.ts";
import { decodeRecord, isLegacyRecord } from "./codec.ts";
import { Metrics } from "./metrics.ts";

export interface TTLOptions {
  cleanupInterval?: number;
  cleanupBatchSize?: number;
}

const DEFAULT_INTERVAL = 1000;
const DEFAULT_BATCH = 500;

async function getRaw(db: Level<any, any>, key: string): Promise<Buffer | undefined> {
  try {
    const raw = await db.get(key, { valueEncoding: "buffer" } as any);
    return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  } catch (error) {
    if ((error as any)?.notFound || (error as any)?.code === "LEVEL_NOT_FOUND") return undefined;
    throw error;
  }
}

export class TTLEngine {
  private timer?: ReturnType<typeof setTimeout>;
  private cleanupPromise?: Promise<void>;
  private running = false;
  private closed = false;

  constructor(
    private db: Level<any, any>,
    private metrics: Metrics,
    private options: TTLOptions = {},
    private runExclusive?: <T>(key: string, operation: () => Promise<T>) => Promise<T>
  ) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.cleanupPromise;
  }

  /**
   * Lazy expiration used on the read path. Returns the remaining TTL in ms,
   * or a negative sentinel:
   *   -1  key exists with no expiration
   *   -2  key does not exist
   *   >=0 remaining milliseconds
   */
  async ttlOf(fullKey: string): Promise<number> {
    const raw = await getRaw(this.db, fullKey);
    if (!raw) return -2;

    const decoded = decodeRecord(raw);
    if (decoded.expiresAt === undefined) return -1;
    const remaining = decoded.expiresAt - Date.now();
    if (remaining <= 0) {
      await this.deleteExpired(fullKey, decoded.expiresAt);
      return -2;
    }
    return remaining;
  }

  /**
   * Check whether a record is logically present (not expired). Used by
   * exists()/get() so they share one read.
   */
  async isExpired(fullKey: string): Promise<boolean> {
    const raw = await getRaw(this.db, fullKey);
    if (!raw) return true;
    const decoded = decodeRecord(raw);
    if (decoded.expiresAt === undefined) return false;
    if (decoded.expiresAt <= Date.now()) {
      await this.deleteExpired(fullKey, decoded.expiresAt);
      return true;
    }
    return false;
  }

  /** Remove a single expired record and its index row. */
  private async deleteExpired(fullKey: string, expiresAt: number): Promise<void> {
    const batch = this.db.batch();
    batch.del(fullKey);
    batch.del(ttlIndexKey(expiresAt, fullKey));
    try {
      await batch.write();
      this.metrics.recordExpired();
    } catch (e) {
      // Best-effort cleanup; the next pass will retry.
    }
  }

  private schedule(): void {
    if (this.closed || !this.running) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.cleanupPromise = this.runCleanup().finally(() => {
        this.cleanupPromise = undefined;
        this.schedule();
      });
    }, this.options.cleanupInterval ?? DEFAULT_INTERVAL);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async runCleanup(): Promise<void> {
    if (this.closed) return;
    const batchSize = Math.max(1, this.options.cleanupBatchSize ?? DEFAULT_BATCH);
    const now = Date.now();
    const range = ttlIndexRange(now);

    this.metrics.ttlCleanupRuns++;

    let deleted = 0;
    let processed = 0;
    try {
      const iter = this.db.iterator({
        gte: range.gte,
        lte: range.lte,
        keys: true,
        values: false
      });

      for await (const entry of iter) {
        const indexKey = Array.isArray(entry) ? entry[0] : entry;
        if (processed >= batchSize) break;
        processed++;
        const parsed = this.parseIndexKey(indexKey);
        if (!parsed) continue;
        const { expiresAt, fullKey } = parsed;
        // Defensive: skip entries that are somehow still in the future.
        if (expiresAt > now) break;

        try {
          const cleanup = async () => {
            const raw = await getRaw(this.db, fullKey);
            const currentExpiration = raw ? decodeRecord(raw).expiresAt : undefined;
            const batch = this.db.batch();
            if (currentExpiration === expiresAt && expiresAt <= Date.now()) batch.del(fullKey);
            batch.del(indexKey);
            await batch.write();
            return currentExpiration === expiresAt && expiresAt <= Date.now();
          };
          const removedRecord = this.runExclusive
            ? await this.runExclusive(fullKey, cleanup)
            : await cleanup();
          if (removedRecord) {
            deleted++;
            this.metrics.recordExpired();
          }
        } catch (e) {
          // Best-effort; continue.
        }
      }
    } catch (e) {
      // Iteration failures are non-fatal; the next tick retries.
    }

    this.metrics.ttlCleanupKeysDeleted += deleted;
  }

  private parseIndexKey(indexKey: string): { expiresAt: number; fullKey: string } | null {
    if (!indexKey.startsWith("ttl/")) return null;
    const firstSlash = indexKey.indexOf("/");
    const secondSlash = indexKey.indexOf("/", firstSlash + 1);
    if (firstSlash !== 3 || secondSlash < 0) return null;
    const expiresAt = parseInt(indexKey.substring(firstSlash + 1, secondSlash), 10);
    if (!Number.isFinite(expiresAt)) return null;
    const fullKey = indexKey.substring(secondSlash + 1);
    if (!fullKey) return null;
    return { expiresAt, fullKey };
  }
}
import { Buffer } from "node:buffer";
