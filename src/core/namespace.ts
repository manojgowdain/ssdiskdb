import type {
  BatchOperation,
  MSetEntry,
  ScanOptions,
  SSDiskDBClient
} from "../index.ts";

export function scopedClient(client: SSDiskDBClient, serverId: string): SSDiskDBClient {
  const prefix = `client:${serverId}:`;
  const scopeKey = (key: string) => `${prefix}${key}`;
  const scoped: Partial<SSDiskDBClient> = {
    set: (key, value, options) => client.set(scopeKey(key), value, options),
    get: (key) => client.get(scopeKey(key)),
    del: (key) => client.del(scopeKey(key)),
    exists: (key) => client.exists(scopeKey(key)),
    expire: (key, ttl) => client.expire(scopeKey(key), ttl),
    ttl: (key) => client.ttl(scopeKey(key)),
    persist: (key) => client.persist(scopeKey(key)),
    incr: (key, num) => client.incr(scopeKey(key), num),
    mget: (keys) => client.mget(keys.map(scopeKey)),
    mset: (entries: MSetEntry[]) => client.mset(entries.map((entry) => Array.isArray(entry)
      ? [scopeKey(entry[0]), entry[1]]
      : { ...entry, key: scopeKey(entry.key) })),
    mdelete: (keys) => client.mdelete(keys.map(scopeKey)),
    batch: (operations: BatchOperation[]) => client.batch(operations.map((operation) => ({
      ...operation,
      key: scopeKey(operation.key)
    })) as BatchOperation[]),
    scan: (options: ScanOptions = {}) => client.scan({
      ...options,
      prefix: `${prefix}${options.prefix ?? ""}`
    }).then((result) => ({
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        key: entry.key.startsWith(prefix) ? entry.key.substring(prefix.length) : entry.key
      }))
    })),
    streamScan: async function* (options: ScanOptions = {}) {
      for await (const entry of client.streamScan({
        ...options,
        prefix: `${prefix}${options.prefix ?? ""}`
      })) {
        yield {
          ...entry,
          key: entry.key.startsWith(prefix) ? entry.key.substring(prefix.length) : entry.key
        };
      }
    },
    hset: (name, key, value, options) => client.hset(scopeKey(name), key, value, options),
    hget: (name, key) => client.hget(scopeKey(name), key),
    hdel: (name, key) => client.hdel(scopeKey(name), key),
    zset: (name, key, score, options) => client.zset(scopeKey(name), key, score, options),
    zget: (name, key) => client.zget(scopeKey(name), key),
    zdel: (name, key) => client.zdel(scopeKey(name), key),
    flush: () => flushNamespace(client, serverId),
    getAllKeys: async () => {
      const all = await client.getAllKeys();
      return all.flatMap((item) => {
        if (item.key.startsWith(`s:${prefix}`)) return [{ ...item, key: `s:${item.key.substring(2 + prefix.length)}` }];
        if (item.key.startsWith(`h:client:${serverId}:`)) return [{ ...item, key: `h:${item.key.substring(`h:client:${serverId}:`.length)}` }];
        if (item.key.startsWith(`z:client:${serverId}:`)) return [{ ...item, key: `z:${item.key.substring(`z:client:${serverId}:`.length)}` }];
        return [];
      });
    },
    stats: () => client.stats(),
    close: async () => {},
    startDashboard: async () => { throw new Error("Dashboard is unavailable on a scoped client"); },
    setCredentials: async () => { throw new Error("Credentials are server-scoped"); },
    getCredentials: async () => { throw new Error("Credentials are server-scoped"); }
  };
  return new Proxy(client, {
    get(target, property) {
      if (typeof property === "string" && property in scoped) return (scoped as any)[property];
      const value = (target as any)[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function flushNamespace(client: SSDiskDBClient, serverId: string): Promise<void> {
  const core = client as SSDiskDBClient & { flushNamespace?: (id: string) => Promise<void> };
  if (core.flushNamespace) return core.flushNamespace(serverId);
  const db = (client as any).db;
  if (!db) throw new Error("Database storage is unavailable");
  const prefixes = [`s:client:${serverId}:`, `h:client:${serverId}:`, `z:client:${serverId}:`];
  const dataKeys = new Set<string>();
  for (const prefix of prefixes) {
    for await (const key of db.keys({ gte: prefix, lte: `${prefix}\uffff` })) dataKeys.add(String(key));
  }
  const deletions = db.batch();
  for (const key of dataKeys) deletions.del(key);
  for await (const keyValue of db.keys({ gte: "ttl/", lte: "ttl/\uffff" })) {
    const key = String(keyValue);
    const secondSlash = key.indexOf("/", 4);
    const dataKey = secondSlash < 0 ? "" : key.substring(secondSlash + 1);
    if (dataKeys.has(dataKey)) deletions.del(key);
  }
  await deletions.write();
}
