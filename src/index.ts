import crypto from "node:crypto";
import type { Level } from "level";
import { startDashboardServer, DashboardServer } from "./dashboard.ts";
import { encodeRecord, decodeRecord } from "./core/codec.ts";
import { ttlIndexKey } from "./core/keys.ts";
import { Metrics } from "./core/metrics.ts";
import { TTLEngine, TTLOptions } from "./core/ttl.ts";
import { LRUCache, CacheOptions } from "./core/cache.ts";
import { StatsSnapshot } from "./core/metrics.ts";
import { encrypt, decrypt, encryptBuffer, decryptBuffer } from "./core/encryption.ts";
import { GrpcSSDiskDBClient, GrpcClientOptions, GrpcTlsClientOptions } from "./grpc/client.ts";
import { startGrpcServer as createGrpcServer, GrpcServerHandle, GrpcServerOptions } from "./grpc/server.ts";

export interface SetOptions {
  ttl?: number;
}

export type MSetEntry = [string, any] | { key: string; value: any; ttl?: number };
export type BatchOperation =
  | { type: "set"; key: string; value: any; ttl?: number }
  | { type: "delete"; key: string };
export interface ScanOptions {
  prefix?: string;
  limit?: number;
  cursor?: string | null;
}
export interface ScanResult {
  cursor: string | null;
  entries: Array<{ key: string; value: any }>;
}

export interface SSDiskDBClient {
  set(key: string, value: any, options?: SetOptions): Promise<any>;
  get(key: string): Promise<any>;
  del(key: string): Promise<any>;
  exists(key: string): Promise<boolean>;
  expire(key: string, ttl: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
  persist(key: string): Promise<boolean>;
  mget(keys: string[]): Promise<any[]>;
  mset(entries: MSetEntry[]): Promise<number>;
  mdelete(keys: string[]): Promise<number>;
  batch(operations: BatchOperation[]): Promise<number>;
  scan(options?: ScanOptions): Promise<ScanResult>;
  streamScan(options?: ScanOptions): AsyncIterable<{ key: string; value: any }>;
  stats(): Promise<StatsSnapshot>;
  startGrpcServer(options?: GrpcServerOptions): Promise<string>;
  incr(key: string, num?: number): Promise<number>;

  hset(name: string, key: string, value: any, options?: SetOptions): Promise<any>;
  hget(name: string, key: string): Promise<any>;
  hdel(name: string, key: string): Promise<any>;

  zset(name: string, key: string, score: number, options?: SetOptions): Promise<any>;
  zget(name: string, key: string): Promise<any>;
  zdel(name: string, key: string): Promise<any>;

  close(): Promise<void>;

  // Dashboard & CLI configurations
  startDashboard(port?: number): Promise<void>;
  getAllKeys(): Promise<{ key: string; value: any }[]>;
  flush(): Promise<void>;
  setCredentials(username: string, passwordHash: string): Promise<void>;
  getCredentials(): Promise<{ username: string; passwordHash: string }>;
}

export interface ConnectOptions {
  storagePath?: string;
  encryptionKey?: string;
  startDashboard?: boolean;
  dashboardPort?: number;
  remoteUrl?: string;
  username?: string;
  password?: string;
  serverId?: string;
  apiKey?: string;
  ttl?: TTLOptions;
  cache?: CacheOptions;
  startGrpcServer?: boolean;
  grpc?: GrpcServerOptions;
  grpcTarget?: string;
  grpcTls?: GrpcTlsClientOptions;
  requestTimeoutMs?: number;
}

function serialize(value: any): string {
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value);
}

function deserialize(value: any): any {
  if (value === undefined || value === null) {
    return undefined;
  }
  const strValue = typeof value === "string" ? value : value.toString();
  try {
    return JSON.parse(strValue);
  } catch (e) {
    return strValue;
  }
}

export class DatabaseCore implements SSDiskDBClient {
  private db: Level<string, string>;
  private encryptionKey?: string;
  private dashboardServer?: DashboardServer;
  private grpcServer?: GrpcServerHandle;
  private ttlEngine: TTLEngine;
  private metrics = new Metrics();
  private cache: LRUCache;
  private keyTails = new Map<string, Promise<void>>();

  constructor(db: Level<string, string>, encryptionKey?: string, ttlOptions: TTLOptions = {}, cacheOptions: CacheOptions = {}) {
    this.db = db;
    this.encryptionKey = encryptionKey;
    this.cache = new LRUCache({ enabled: false, ...cacheOptions });
    this.ttlEngine = new TTLEngine(db, this.metrics, ttlOptions, (key, fn) => this.withKeyLock(key, fn));
    this.ttlEngine.start();
  }

  private getFullKey(prefix: string, name: string, key?: string): string {
    if (key === undefined) {
      return `${prefix}:${name}`;
    }
    return `${prefix}:${name}:${key}`;
  }

  private async withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.keyTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
    }
  }

  private async withKeyLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => index === orderedKeys.length
      ? operation()
      : this.withKeyLock(orderedKeys[index], () => acquire(index + 1));
    return acquire(0);
  }

  private async readRecord(fullKey: string): Promise<{ payload: Buffer; expiresAt?: number } | undefined> {
    const raw = await this.db.get(fullKey, { valueEncoding: "buffer" } as any) as unknown as Buffer | undefined;
    if (raw === undefined) return undefined;
    const decoded = decodeRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
    return { payload: decoded.payload, expiresAt: decoded.expiresAt };
  }

  private async readRecords(fullKeys: string[]): Promise<Array<{ payload: Buffer; expiresAt?: number } | undefined>> {
    if (fullKeys.length === 0) return [];
    const values = await this.db.getMany(fullKeys, { valueEncoding: "buffer" } as any) as Array<Buffer | string | undefined>;
    return values.map((raw) => {
      if (raw === undefined) return undefined;
      const decoded = decodeRecord(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
      return { payload: decoded.payload, expiresAt: decoded.expiresAt };
    });
  }

  private async readLiveRecord(fullKey: string): Promise<{ payload: Buffer; expiresAt?: number } | undefined> {
    const record = await this.readRecord(fullKey);
    if (!record) return undefined;
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      const batch = this.db.batch();
      batch.del(fullKey);
      batch.del(ttlIndexKey(record.expiresAt, fullKey));
      await batch.write();
      this.cache.invalidate(fullKey);
      this.metrics.recordExpired();
      return undefined;
    }
    return record;
  }

  private async writeRecord(fullKey: string, payload: Buffer, expiresAt?: number, previousExpiresAt?: number): Promise<void> {
    const encoded = encodeRecord(payload, expiresAt);
    if (expiresAt === undefined && previousExpiresAt === undefined) {
      await this.db.put(fullKey, encoded, { valueEncoding: "buffer" } as any);
    } else {
      const batch = this.db.batch();
      if (previousExpiresAt !== undefined) batch.del(ttlIndexKey(previousExpiresAt, fullKey));
      batch.put(fullKey, encoded, { valueEncoding: "buffer" } as any);
      if (expiresAt !== undefined) batch.put(ttlIndexKey(expiresAt, fullKey), "", { valueEncoding: "utf8" } as any);
      await batch.write();
    }
    this.cache.invalidate(fullKey);
    this.metrics.recordWrite(encoded.length);
  }

  private async commitRecords(
    records: Array<{ key: string; payload: Buffer; expiresAt?: number }>,
    deleteKeys: string[]
  ): Promise<number> {
    const keys = [...new Set([...records.map((record) => record.key), ...deleteKeys])];
    if (keys.length === 0) return 0;
    const batch = this.db.batch();
    // Old expiration rows are harmless: cleanup validates the current primary
    // record before deleting it, then removes stale rows. This keeps bulk writes
    // to one LevelDB batch without a separate metadata read per key.
    for (const key of deleteKeys) batch.del(key);
    for (const record of records) {
      const encoded = encodeRecord(record.payload, record.expiresAt);
      batch.put(record.key, encoded, { valueEncoding: "buffer" } as any);
      if (record.expiresAt !== undefined) {
        batch.put(ttlIndexKey(record.expiresAt, record.key), "", { valueEncoding: "utf8" } as any);
      }
      this.metrics.bytesWritten += encoded.length;
    }
    await batch.write();
    for (const key of keys) this.cache.invalidate(key);
    this.metrics.writes += records.length;
    this.metrics.deletes += deleteKeys.length;
    return records.length + deleteKeys.length;
  }

  async mget(keys: string[]): Promise<any[]> {
    const fullKeys = keys.map((key) => this.getFullKey("s", key));
    return this.withKeyLocks(fullKeys, async () => {
      const records = await this.readRecords(fullKeys);
      const now = Date.now();
      const expired: Array<{ key: string; expiresAt: number }> = [];
      const values = records.map((record, index) => {
        if (!record) return undefined;
        if (record.expiresAt !== undefined && record.expiresAt <= now) {
          expired.push({ key: fullKeys[index], expiresAt: record.expiresAt });
          return undefined;
        }
        this.metrics.recordRead(record.payload.length);
        return this.decodePayload(record.payload);
      });
      if (expired.length > 0) {
        const cleanup = this.db.batch();
        for (const record of expired) {
          cleanup.del(record.key);
          cleanup.del(ttlIndexKey(record.expiresAt, record.key));
        }
        await cleanup.write();
        expired.forEach(() => this.metrics.recordExpired());
      }
      return values;
    });
  }

  async mset(entries: MSetEntry[]): Promise<number> {
    const records = new Map<string, { key: string; payload: Buffer; expiresAt?: number }>();
    for (const entry of entries) {
      const [key, value, ttl] = Array.isArray(entry)
        ? [entry[0], entry[1], undefined]
        : [entry.key, entry.value, entry.ttl];
      records.set(this.getFullKey("s", key), {
        key: this.getFullKey("s", key),
        payload: this.encodePayload(value),
        expiresAt: ttl === undefined ? undefined : this.validateTtl(ttl)
      });
    }
    const list = [...records.values()];
    return this.withKeyLocks(list.map((record) => record.key), () => this.commitRecords(list, []));
  }

  async mdelete(keys: string[]): Promise<number> {
    const fullKeys = [...new Set(keys.map((key) => this.getFullKey("s", key)))];
    return this.withKeyLocks(fullKeys, () => this.commitRecords([], fullKeys));
  }

  async batch(operations: BatchOperation[]): Promise<number> {
    const finalOperations = new Map<string, BatchOperation>();
    for (const operation of operations) {
      if (operation.type !== "set" && operation.type !== "delete") {
        throw new TypeError("Batch operation type must be 'set' or 'delete'");
      }
      if (typeof operation.key !== "string") throw new TypeError("Batch operation key must be a string");
      finalOperations.set(this.getFullKey("s", operation.key), operation);
    }
    const records: Array<{ key: string; payload: Buffer; expiresAt?: number }> = [];
    const deleteKeys: string[] = [];
    for (const [key, operation] of finalOperations) {
      if (operation.type === "delete") deleteKeys.push(key);
      else records.push({
        key,
        payload: this.encodePayload(operation.value),
        expiresAt: operation.ttl === undefined ? undefined : this.validateTtl(operation.ttl)
      });
    }
    return this.withKeyLocks([...records.map((record) => record.key), ...deleteKeys], () => this.commitRecords(records, deleteKeys));
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new RangeError("Scan limit must be an integer from 1 to 5000");
    }
    const keyPrefix = this.getFullKey("s", prefix);
    const start = options.cursor ? undefined : keyPrefix;
    const end = `${keyPrefix}\uffff`;
    const iter = this.db.iterator({
      ...(start === undefined ? { gt: options.cursor! } : { gte: start }),
      lte: end,
      keys: true,
      values: true,
      valueEncoding: "buffer"
    } as any);
    const entries: Array<{ key: string; value: any }> = [];
    let lastKey: string | null = null;
    let hasMore = false;
    const now = Date.now();
    for await (const [rawKey, rawValue] of iter) {
      const key = String(rawKey);
      if (!key.startsWith(keyPrefix)) break;
      const record = decodeRecord(Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(String(rawValue)));
      if (record.expiresAt !== undefined && record.expiresAt <= now) continue;
      if (entries.length === limit) {
        hasMore = true;
        break;
      }
      entries.push({ key: key.substring(2), value: this.decodePayload(record.payload) });
      lastKey = key;
      this.metrics.recordRead(record.payload.length);
    }
    return { cursor: hasMore ? lastKey : null, entries };
  }

  async *streamScan(options: ScanOptions = {}): AsyncIterable<{ key: string; value: any }> {
    let cursor = options.cursor ?? undefined;
    const pageSize = Math.min(options.limit ?? 500, 5000);
    while (true) {
      const page = await this.scan({ ...options, limit: pageSize, cursor });
      for (const entry of page.entries) yield entry;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  async stats(): Promise<StatsSnapshot> {
    return this.metrics.snapshot();
  }

  async startGrpcServer(options: GrpcServerOptions = {}): Promise<string> {
    if (!this.grpcServer) this.grpcServer = await createGrpcServer(this, options);
    return this.grpcServer.address;
  }

  private validateTtl(ttl: number): number {
    if (!Number.isFinite(ttl) || ttl < 0) throw new RangeError("TTL must be a finite non-negative number of milliseconds");
    const expiresAt = Date.now() + ttl;
    if (!Number.isSafeInteger(Math.floor(expiresAt))) throw new RangeError("TTL exceeds the supported timestamp range");
    return Math.floor(expiresAt);
  }

  private decodePayload(payload: Buffer): any {
    if (payload[0] === 1) return Buffer.from(payload.subarray(1));
    if (payload[0] === 2) {
      if (!this.encryptionKey) throw new Error("Encryption key is required for this value");
      return decryptBuffer(payload.subarray(1), this.encryptionKey);
    }
    const data = payload[0] === 0 ? payload.subarray(1) : payload;
    let raw = data.toString("utf8");
    if (this.encryptionKey) raw = decrypt(raw, this.encryptionKey);
    if (raw.startsWith("ssdiskdb:bytes:")) return Buffer.from(raw.slice("ssdiskdb:bytes:".length), "base64");
    return deserialize(raw);
  }

  private encodePayload(value: any): Buffer {
    if (Buffer.isBuffer(value)) {
      if (!this.encryptionKey) return Buffer.concat([Buffer.from([1]), value]);
      return Buffer.concat([Buffer.from([2]), encryptBuffer(value, this.encryptionKey)]);
    }
    const serialized = serialize(value);
    const stored = this.encryptionKey ? encrypt(serialized, this.encryptionKey) : serialized;
    return Buffer.concat([Buffer.from([0]), Buffer.from(stored, "utf8")]);
  }

  async set(key: string, value: any, options: SetOptions = {}): Promise<any> {
    const fullKey = this.getFullKey("s", key);
    const expiresAt = options.ttl === undefined ? undefined : this.validateTtl(options.ttl);
    return this.withKeyLock(fullKey, async () => {
      await this.writeRecord(fullKey, this.encodePayload(value), expiresAt);
      return 1;
    });
  }

  async get(key: string): Promise<any> {
    const fullKey = this.getFullKey("s", key);
    if (!this.cache.isEnabled) {
      const record = await this.readRecord(fullKey);
      if (!record) return undefined;
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
        return this.withKeyLock(fullKey, async () => {
          const live = await this.readLiveRecord(fullKey);
          return live ? this.decodePayload(live.payload) : undefined;
        });
      }
      this.metrics.recordRead(record.payload.length);
      return this.decodePayload(record.payload);
    }
    return this.withKeyLock(fullKey, async () => {
      const cached = this.cache.get(fullKey);
      if (cached) {
        this.metrics.recordCacheHit();
        return this.decodePayload(Buffer.from(cached.value));
      }
      this.metrics.recordCacheMiss();
      const record = await this.readLiveRecord(fullKey);
      if (!record) return undefined;
      this.metrics.recordRead(record.payload.length);
      this.cache.set(fullKey, { value: Buffer.from(record.payload), expiresAt: record.expiresAt });
      return this.decodePayload(record.payload);
    });
  }

  async del(key: string): Promise<any> {
    const fullKey = this.getFullKey("s", key);
    return this.withKeyLock(fullKey, async () => {
      await this.db.del(fullKey);
      this.cache.invalidate(fullKey);
      this.metrics.recordDelete();
      return 1;
    });
  }

  async exists(key: string): Promise<boolean> {
    const fullKey = this.getFullKey("s", key);
    const record = await this.readRecord(fullKey);
    if (!record) return false;
    if (record.expiresAt === undefined || record.expiresAt > Date.now()) return true;
    return this.withKeyLock(fullKey, async () => (await this.readLiveRecord(fullKey)) !== undefined);
  }

  async ttl(key: string): Promise<number> {
    const fullKey = this.getFullKey("s", key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      if (!record) return -2;
      return record.expiresAt === undefined ? -1 : Math.max(0, record.expiresAt - Date.now());
    });
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    const expiresAt = this.validateTtl(ttl);
    const fullKey = this.getFullKey("s", key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      if (!record) return false;
      await this.writeRecord(fullKey, record.payload, expiresAt);
      return true;
    });
  }

  async persist(key: string): Promise<boolean> {
    const fullKey = this.getFullKey("s", key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      if (!record || record.expiresAt === undefined) return false;
      await this.writeRecord(fullKey, record.payload, undefined, record.expiresAt);
      return true;
    });
  }

  async incr(key: string, num: number = 1): Promise<number> {
    const fullKey = this.getFullKey("s", key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      const val = record ? Number(this.decodePayload(record.payload)) || 0 : 0;
      const newVal = val + num;
      await this.writeRecord(fullKey, this.encodePayload(newVal), record?.expiresAt);
      return newVal;
    });
  }

  async hset(name: string, key: string, value: any, options: SetOptions = {}): Promise<any> {
    const fullKey = this.getFullKey("h", name, key);
    const expiresAt = options.ttl === undefined ? undefined : this.validateTtl(options.ttl);
    return this.withKeyLock(fullKey, async () => {
      await this.writeRecord(fullKey, this.encodePayload(value), expiresAt);
      return 1;
    });
  }

  async hget(name: string, key: string): Promise<any> {
    const fullKey = this.getFullKey("h", name, key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      if (!record) return undefined;
      this.metrics.recordRead(record.payload.length);
      this.cache.set(fullKey, { value: Buffer.from(record.payload), expiresAt: record.expiresAt });
      return this.decodePayload(record.payload);
    });
  }

  async hdel(name: string, key: string): Promise<any> {
    return this.deleteRecord(this.getFullKey("h", name, key));
  }

  async zset(name: string, key: string, score: number, options: SetOptions = {}): Promise<any> {
    const fullKey = this.getFullKey("z", name, key);
    const expiresAt = options.ttl === undefined ? undefined : this.validateTtl(options.ttl);
    return this.withKeyLock(fullKey, async () => {
      await this.writeRecord(fullKey, this.encodePayload(score), expiresAt);
      return 1;
    });
  }

  async zget(name: string, key: string): Promise<any> {
    const fullKey = this.getFullKey("z", name, key);
    return this.withKeyLock(fullKey, async () => {
      const record = await this.readLiveRecord(fullKey);
      if (!record) return undefined;
      this.metrics.recordRead(record.payload.length);
      this.cache.set(fullKey, { value: Buffer.from(record.payload), expiresAt: record.expiresAt });
      return this.decodePayload(record.payload);
    });
  }

  async zdel(name: string, key: string): Promise<any> {
    return this.deleteRecord(this.getFullKey("z", name, key));
  }

  private async deleteRecord(fullKey: string): Promise<number> {
    return this.withKeyLock(fullKey, async () => {
      await this.db.del(fullKey);
      this.cache.invalidate(fullKey);
      this.metrics.recordDelete();
      return 1;
    });
  }

  async getAllKeys(): Promise<{ key: string; value: any }[]> {
    const list: { key: string; value: any }[] = [];
    for await (const [key, value] of this.db.iterator({ valueEncoding: "buffer" } as any)) {
      if (!key.startsWith("config:") && !key.startsWith("ttl/")) {
        const record = decodeRecord(Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
        if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) continue;
        list.push({ key, value: this.decodePayload(record.payload) });
      }
    }
    return list;
  }

  async flush(): Promise<void> {
    const batch = this.db.batch();
    for await (const key of this.db.keys()) {
      if (!key.startsWith("config:")) {
        batch.del(key);
      }
    }
    await batch.write();
    this.cache.clear();
  }

  async flushNamespace(serverId: string): Promise<void> {
    const prefixes = [`s:client:${serverId}:`, `h:client:${serverId}:`, `z:client:${serverId}:`];
    const dataKeys = new Set<string>();
    for (const prefix of prefixes) {
      for await (const key of this.db.keys({ gte: prefix, lte: `${prefix}\uffff` })) dataKeys.add(String(key));
    }
    const batch = this.db.batch();
    for (const key of dataKeys) {
      batch.del(key);
      this.cache.invalidate(key);
    }
    for await (const indexKey of this.db.keys({ gte: "ttl/", lte: "ttl/\uffff" })) {
      const key = String(indexKey);
      const slash = key.indexOf("/", 4);
      if (slash >= 0 && dataKeys.has(key.substring(slash + 1))) batch.del(key);
    }
    await batch.write();
  }

  async setCredentials(username: string, passwordHash: string): Promise<void> {
    await this.db.put("config:username", username);
    await this.db.put("config:password", passwordHash);
  }

  async getCredentials(): Promise<{ username: string; passwordHash: string }> {
    const defaultHash = crypto.createHash("sha256").update("manoj").digest("hex");
    let username = "manoj";
    let passwordHash = defaultHash;
    try {
      const u = await this.db.get("config:username");
      if (u) username = u;
    } catch (e) {}
    try {
      const p = await this.db.get("config:password");
      if (p) passwordHash = p;
    } catch (e) {}
    return { username, passwordHash };
  }

  async startDashboard(port: number = 8971): Promise<void> {
    if (this.dashboardServer) {
      return;
    }
    this.dashboardServer = await startDashboardServer(this, port, () => this.getCredentials());
  }

  async close(): Promise<void> {
    if (this.grpcServer) {
      await this.grpcServer.close();
      this.grpcServer = undefined;
    }
    await this.ttlEngine.stop();
    if (this.dashboardServer) {
      await this.dashboardServer.close();
      this.dashboardServer = undefined;
    }
    await this.db.close();
  }
}

class LocalSSDBClient extends DatabaseCore {}

class RemoteSSDiskDBClient implements SSDiskDBClient {
  public remoteUrl: string;
  public apiKey: string;
  public serverId: string;
  private encryptionKey?: string;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private dashboardServer?: DashboardServer;

  constructor(remoteUrl: string, apiKey: string, serverId: string, encryptionKey?: string) {
    this.remoteUrl = remoteUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.serverId = serverId;
    this.encryptionKey = encryptionKey;
  }

  async handshake(): Promise<void> {
    try {
      const res = await fetch(`${this.remoteUrl}/api/handshake`, {
        method: "GET",
        headers: {
          "X-API-Key": this.apiKey,
          "X-Server-Id": this.serverId
        }
      });
      if (res.status === 403) {
        throw new Error(`Forbidden: Invalid API Key or Server ID ("${this.serverId}")`);
      }
      if (!res.ok) {
        throw new Error(`Handshake failed: Server returned ${res.status}`);
      }
      this.startHeartbeat();
    } catch (err: any) {
      if (err.message.includes("Forbidden") || err.message.includes("Handshake")) {
        throw err;
      }
      throw new Error(`Connection check failed: Central server is unreachable at ${this.remoteUrl} (${err.message})`);
    }
  }

  private startHeartbeat() {
    this.sendHeartbeat().catch(err => {
      console.error(`[SSDiskDB Client] Initial heartbeat failed: ${err.message}`);
    });
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat().catch(err => {
        console.error(`[SSDiskDB Client] Periodic heartbeat failed: ${err.message}`);
      });
    }, 10000);
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const res = await fetch(`${this.remoteUrl}/api/heartbeat`, {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ serverId: this.serverId })
      });
      if (res.status === 403) {
        console.warn(`[SSDiskDB Client] WARNING: This client server ("${this.serverId}") is not authorized/registered on the central cache server.`);
      } else if (!res.ok) {
        const text = await res.text();
        console.warn(`[SSDiskDB Client] Heartbeat server error: ${text}`);
      }
    } catch (err: any) {
      console.warn(`[SSDiskDB Client] Heartbeat network error: ${err.message}`);
    }
  }

  private async request(action: string, args: any[]): Promise<any> {
    const res = await fetch(`${this.remoteUrl}/api/rpc`, {
      method: "POST",
      headers: {
        "X-API-Key": this.apiKey,
        "X-Server-Id": this.serverId,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action, args })
    });

    if (res.status === 403) {
      throw new Error(`Connection Forbidden: This client server ("${this.serverId}") is not authorized/registered on the central cache server.`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RPC server error: ${text}`);
    }

    const json = await res.json();
    return json.result;
  }

  async set(key: string, value: any, options: SetOptions = {}): Promise<any> {
    if (this.encryptionKey) {
      let serialized = serialize(value);
      serialized = encrypt(serialized, this.encryptionKey);
      return this.request("set", [key, serialized, options]);
    }
    return this.request("set", [key, value, options]);
  }

  async get(key: string): Promise<any> {
    let res = await this.request("get", [key]);
    if (this.encryptionKey && res !== undefined && res !== null) {
      res = decrypt(res, this.encryptionKey);
      res = deserialize(res);
    }
    return res;
  }

  async del(key: string): Promise<any> {
    return this.request("del", [key]);
  }

  async exists(key: string): Promise<boolean> {
    return this.request("exists", [key]);
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    return this.request("expire", [key, ttl]);
  }

  async ttl(key: string): Promise<number> {
    return this.request("ttl", [key]);
  }

  async persist(key: string): Promise<boolean> {
    return this.request("persist", [key]);
  }

  async mget(keys: string[]): Promise<any[]> {
    const values = await this.request("mget", [keys]);
    if (!this.encryptionKey) return values;
    return values.map((value: any) => value == null ? value : this.decodeRemoteValue(value));
  }

  async mset(entries: MSetEntry[]): Promise<number> {
    if (!this.encryptionKey) return this.request("mset", [entries]);
    const encrypted = entries.map((entry) => {
      if (Array.isArray(entry)) return [entry[0], encrypt(serialize(entry[1]), this.encryptionKey!)];
      return { ...entry, value: encrypt(serialize(entry.value), this.encryptionKey!) };
    });
    return this.request("mset", [encrypted]);
  }

  async mdelete(keys: string[]): Promise<number> {
    return this.request("mdelete", [keys]);
  }

  async batch(operations: BatchOperation[]): Promise<number> {
    if (!this.encryptionKey) return this.request("batch", [operations]);
    const encrypted = operations.map((operation) => operation.type === "set"
      ? { ...operation, value: encrypt(serialize(operation.value), this.encryptionKey!) }
      : operation);
    return this.request("batch", [encrypted]);
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const result = await this.request("scan", [options]);
    if (this.encryptionKey) {
      result.entries = result.entries.map((entry: any) => ({ ...entry, value: this.decodeRemoteValue(entry.value) }));
    }
    return result;
  }

  async *streamScan(options: ScanOptions = {}): AsyncIterable<{ key: string; value: any }> {
    let cursor = options.cursor ?? undefined;
    while (true) {
      const page = await this.scan({ ...options, cursor });
      for (const entry of page.entries) yield entry;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  async stats(): Promise<StatsSnapshot> {
    return this.request("stats", []);
  }

  private decodeRemoteValue(value: any): any {
    if (typeof value !== "string") return value;
    try {
      return deserialize(decrypt(value, this.encryptionKey!));
    } catch (error) {
      if (value.startsWith("gcm:v1:") || /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(value)) throw error;
      return value;
    }
  }

  async incr(key: string, num: number = 1): Promise<number> {
    if (this.encryptionKey) {
      const val = await this.get(key);
      const newVal = (Number(val) || 0) + num;
      await this.set(key, newVal);
      return newVal;
    }
    return this.request("incr", [key, num]);
  }

  async hset(name: string, key: string, value: any, options: SetOptions = {}): Promise<any> {
    if (this.encryptionKey) {
      let serialized = serialize(value);
      serialized = encrypt(serialized, this.encryptionKey);
      return this.request("hset", [name, key, serialized, options]);
    }
    return this.request("hset", [name, key, value, options]);
  }

  async hget(name: string, key: string): Promise<any> {
    let res = await this.request("hget", [name, key]);
    if (this.encryptionKey && res !== undefined && res !== null) {
      res = decrypt(res, this.encryptionKey);
      res = deserialize(res);
    }
    return res;
  }

  async hdel(name: string, key: string): Promise<any> {
    return this.request("hdel", [name, key]);
  }

  async zset(name: string, key: string, score: number, options: SetOptions = {}): Promise<any> {
    return this.request("zset", [name, key, score, options]);
  }

  async zget(name: string, key: string): Promise<any> {
    return this.request("zget", [name, key]);
  }

  async zdel(name: string, key: string): Promise<any> {
    return this.request("zdel", [name, key]);
  }

  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.dashboardServer) {
      await this.dashboardServer.close();
      this.dashboardServer = undefined;
    }
  }

  async startDashboard(port: number = 8971): Promise<void> {
    if (this.dashboardServer) {
      return;
    }
    this.dashboardServer = await startDashboardServer(this, port, async () => {
      return { username: "admin", passwordHash: "" };
    });
  }

  async getAllKeys(): Promise<{ key: string; value: any }[]> {
    const list = await this.request("getAllKeys", []);
    return list.map((item: any) => {
      let parsedVal = item.value;
      if (this.encryptionKey && typeof parsedVal === "string") {
        try {
          parsedVal = decrypt(parsedVal, this.encryptionKey);
          parsedVal = deserialize(parsedVal);
        } catch (e) {}
      }
      return { key: item.key, value: parsedVal };
    });
  }

  async flush(): Promise<void> {
    return this.request("flush", []);
  }

  async setCredentials(username: string, passwordHash: string): Promise<void> {
    throw new Error("Method not supported on remote client connection");
  }

  async getCredentials(): Promise<{ username: string; passwordHash: string }> {
    throw new Error("Method not supported on remote client connection");
  }

  async startGrpcServer(): Promise<string> {
    throw new Error("Cannot start a gRPC server from a remote connection");
  }
}

export function parseConnectionString(uri: string): ConnectOptions {
  try {
    const grpcMatch = uri.match(/^ssdiskdb\+grpc(\+encry)?:\/\/([^@]+)@([^/]+)\/([^?#]+)(?:\?key=([^#]+))?$/);
    if (grpcMatch) {
      const encrypted = Boolean(grpcMatch[1]);
      const encryptionKey = grpcMatch[5];
      if (encrypted && !encryptionKey) throw new Error("Encryption key is required for ssdiskdb+grpc+encry:// protocol");
      return {
        grpcTarget: grpcMatch[3],
        apiKey: grpcMatch[2],
        serverId: grpcMatch[4],
        encryptionKey: encryptionKey || undefined
      };
    }
    const match = uri.match(/^ssdiskdb(\+encry)?:\/\/([^@]+)@([^/]+)\/([^?#]+)(?:\?key=([^#]+))?$/);
    if (!match) {
      throw new Error("Invalid connection URI format");
    }
    const isEncrypted = !!match[1];
    const apiKey = match[2];
    const host = match[3];
    const serverId = match[4];
    const encryptionKey = match[5];
    
    if (isEncrypted && !encryptionKey) {
      throw new Error("Encryption key is required for ssdiskdb+encry:// protocol");
    }

    return {
      remoteUrl: `http://${host}`,
      apiKey,
      serverId,
      encryptionKey: encryptionKey || undefined
    };
  } catch (e: any) {
    throw new Error(`Failed to parse connection URI: ${e.message}`);
  }
}

export async function connect(
  pathOrOptions?: string | ConnectOptions,
  options?: ConnectOptions
): Promise<SSDiskDBClient> {
  let storagePath = "./ssdb-local-db";
  let encryptionKey: string | undefined;
  let startDashboard = false;
  let dashboardPort = 8971;
  let remoteUrl: string | undefined;
  let grpcTarget: string | undefined;
  let apiKey: string | undefined;
  let serverId = "Local";
  let ttlOptions: TTLOptions | undefined;
  let cacheOptions: CacheOptions | undefined;

  if (typeof pathOrOptions === "string") {
    if (pathOrOptions.startsWith("ssdiskdb://") || pathOrOptions.startsWith("ssdiskdb+encry://") || pathOrOptions.startsWith("ssdiskdb+grpc://") || pathOrOptions.startsWith("ssdiskdb+grpc+encry://")) {
      const parsed = parseConnectionString(pathOrOptions);
      remoteUrl = parsed.remoteUrl;
      grpcTarget = parsed.grpcTarget;
      apiKey = parsed.apiKey;
      serverId = parsed.serverId || "Local";
      encryptionKey = parsed.encryptionKey;
    } else {
      storagePath = pathOrOptions;
    }
    if (options) {
      if (options.encryptionKey !== undefined) encryptionKey = options.encryptionKey;
      if (options.startDashboard !== undefined) startDashboard = options.startDashboard;
      if (options.dashboardPort !== undefined) dashboardPort = options.dashboardPort;
      if (options.remoteUrl !== undefined) remoteUrl = options.remoteUrl;
      if (options.grpcTarget !== undefined) grpcTarget = options.grpcTarget;
      if (options.apiKey !== undefined) apiKey = options.apiKey;
      if (options.serverId !== undefined) serverId = options.serverId;
      if (options.ttl !== undefined) ttlOptions = options.ttl;
      if (options.cache !== undefined) cacheOptions = options.cache;
    }
  } else if (pathOrOptions && typeof pathOrOptions === "object") {
    let uriParsed: ConnectOptions | undefined;
    if (pathOrOptions.storagePath && (pathOrOptions.storagePath.startsWith("ssdiskdb://") || pathOrOptions.storagePath.startsWith("ssdiskdb+encry://") || pathOrOptions.storagePath.startsWith("ssdiskdb+grpc://") || pathOrOptions.storagePath.startsWith("ssdiskdb+grpc+encry://"))) {
      uriParsed = parseConnectionString(pathOrOptions.storagePath);
    }
    
    if (uriParsed) {
      remoteUrl = uriParsed.remoteUrl;
      grpcTarget = uriParsed.grpcTarget;
      apiKey = uriParsed.apiKey;
      serverId = uriParsed.serverId || "Local";
      encryptionKey = uriParsed.encryptionKey;
    } else {
      if (pathOrOptions.storagePath) storagePath = pathOrOptions.storagePath;
    }
    if (pathOrOptions.encryptionKey !== undefined) encryptionKey = pathOrOptions.encryptionKey;
    if (pathOrOptions.startDashboard !== undefined) startDashboard = pathOrOptions.startDashboard;
    if (pathOrOptions.dashboardPort !== undefined) dashboardPort = pathOrOptions.dashboardPort;
    if (pathOrOptions.remoteUrl !== undefined) remoteUrl = pathOrOptions.remoteUrl;
    if (pathOrOptions.grpcTarget !== undefined) grpcTarget = pathOrOptions.grpcTarget;
    if (pathOrOptions.apiKey !== undefined) apiKey = pathOrOptions.apiKey;
    if (pathOrOptions.serverId !== undefined) serverId = pathOrOptions.serverId;
    if (pathOrOptions.ttl !== undefined) ttlOptions = pathOrOptions.ttl;
    if (pathOrOptions.cache !== undefined) cacheOptions = pathOrOptions.cache;
  }

  if (grpcTarget) {
    if (!apiKey) throw new Error("apiKey is required for gRPC connections");
    const client = new GrpcSSDiskDBClient({
      target: grpcTarget,
      apiKey,
      serverId,
      encryptionKey,
      tls: pathOrOptions && typeof pathOrOptions === "object" ? pathOrOptions.grpcTls : options?.grpcTls,
      requestTimeoutMs: pathOrOptions && typeof pathOrOptions === "object" ? pathOrOptions.requestTimeoutMs : options?.requestTimeoutMs
    });
    await client.handshake();
    if (startDashboard) await client.startDashboard(dashboardPort);
    return client;
  }

  if (remoteUrl) {
    if (!apiKey) {
      throw new Error("apiKey is required for remote connections");
    }
    const client = new RemoteSSDiskDBClient(remoteUrl, apiKey, serverId, encryptionKey);
    await client.handshake();
    if (startDashboard) {
      await client.startDashboard(dashboardPort);
    }
    return client;
  }

  const { Level: LevelDatabase } = await import("level");
  const levelDb = new LevelDatabase(storagePath);
  await levelDb.open();
  const client = new LocalSSDBClient(levelDb, encryptionKey, ttlOptions, cacheOptions);
  if (pathOrOptions && typeof pathOrOptions === "object" && pathOrOptions.startGrpcServer) {
    await client.startGrpcServer(pathOrOptions.grpc ?? {});
  }
  if (startDashboard) {
    await client.startDashboard(dashboardPort);
  }
  return client;
}

export default {
  connect
};
import { Buffer } from "node:buffer";
