# SSDiskDB

SSDiskDB is an embedded, disk-backed key-value database for Node.js. It stores records in LevelDB and provides String, Hash, and Sorted Set APIs, persistent expiration, batching, cursor scans, an optional bounded cache, a browser dashboard, and a gRPC remote interface.

## Install

```bash
npm install @manojgowdain/ssdiskdb
```

## Local use

```ts
import { connect } from "@manojgowdain/ssdiskdb";

const db = await connect();
await db.set("name", "Manoj");
console.log(await db.get("name"));
await db.close();
```

`connect()` opens `./ssdb-local-db` by default. Existing `connect(path)` calls and the existing String, Hash, Sorted Set, dashboard, and CLI APIs remain available. The local process owns LevelDB; remote clients connect to that process.

Values are JSON serialized by default. Node `Buffer` values are stored and returned as binary. Existing unframed LevelDB JSON records remain readable.

## TTL

TTL is expressed in milliseconds and stored with the primary record. `set`, `hset`, and `zset` accept `{ ttl }`. `expire(key, ttl)` sets/replaces expiry and `persist(key)` removes it. Expired records act as absent records. `ttl(key)` returns `-2` for missing/expired, `-1` for no expiry, or the non-negative remaining milliseconds.

```ts
await db.set("session", { userId: 123 }, { ttl: 60_000 });
console.log(await db.ttl("session"));
await db.expire("session", 30_000);
await db.persist("session");
```

Expiration is restart-safe. A single unref'ed cleanup worker walks the ordered `ttl/<expiresAt>/<dataKey>` index in bounded batches; reads also lazily delete expired records. Old records without TTL metadata never expire. Configure it with `ttl: { cleanupInterval: 1000, cleanupBatchSize: 500 }`.

## Bulk operations and scans

```ts
await db.mset([["user:1", user1], ["user:2", user2]]);
const users = await db.mget(["user:1", "user:2"]);
await db.mdelete(["user:1", "user:2"]);
await db.batch([
  { type: "set", key: "a", value: 1 },
  { type: "set", key: "b", value: 2, ttl: 60_000 },
  { type: "delete", key: "c" }
]);

const page = await db.scan({ prefix: "user:", limit: 100 });
const nextPage = await db.scan({ prefix: "user:", limit: 100, cursor: page.cursor });
for await (const entry of db.streamScan({ prefix: "user:", limit: 100 })) {
  // consume one entry at a time
}
```

`mget` uses Level's multi-read API; writes/deletes use LevelDB batches. Scans use ordered LevelDB iterators and opaque cursor pagination. `batch()` currently supports String set/delete operations.

## gRPC remote access

The primary remote database protocol is gRPC over HTTP/2 using Protocol Buffers. The dashboard's browser/admin HTTP interface and the legacy REST/JSON-RPC route remain for compatibility; new application clients should use gRPC.

Start a local database and gRPC listener:

```bash
npx ssdiskdb start --path ./data --port 8971 --grpc-port 8972
```

Register a client to get an API key, then connect:

```bash
npx ssdiskdb server add app-server --path ./data
```

```ts
const remote = await connect("ssdiskdb+grpc://API_KEY@localhost:8972/app-server");
await remote.set("name", "Manoj");
console.log(await remote.get("name"));
await remote.close();
```

Encrypted client-side values use `ssdiskdb+grpc+encry://API_KEY@HOST:PORT/SERVER_ID?key=SECRET`. The encryption key is client supplied and is never sent as authentication metadata. The prior `ssdiskdb://` and `ssdiskdb+encry://` HTTP URI schemes remain accepted for older deployments; they do not implicitly switch to gRPC.

One persistent gRPC channel is reused per client. Requests have configurable deadlines and message limits. Batch methods are one RPC and one logical LevelDB batch. Streaming scan yields entries incrementally. The server checks the Bearer API key and server ID on every RPC and scopes operations to that server's namespace.

### TLS

For production, configure server `privateKey` and `certChain` (and `rootCert` plus `requireClientCertificate` for mutual TLS) in `GrpcServerOptions`. Configure client `grpcTls: { rootCert, serverName }`; mTLS clients also provide `privateKey` and `certChain`. Without TLS, gRPC uses insecure transport, suitable only for trusted local networks. TLS protects the channel; application-level encryption is separate.

The `.proto` schema is in `proto/ssdiskdb.proto`. It exposes handshake, String CRUD, TTL, batch, Hash, Sorted Set, scan/stream scan, stats, flush, and key listing operations.

## API keys and dashboard

The existing CLI server registration and API-key configuration are retained. The gRPC server validates the key and registered server ID before database operations. Data operations run inside that server's namespace. Existing dashboard login, server/client management, and RBAC remain in the dashboard HTTP layer. Do not expose an insecure listener to an untrusted network; configure TLS and restrict network access.

Start dashboard only with `npx ssdiskdb start --port 8971`. Existing CLI commands remain, with `ttl <key>`, `expire <key> <milliseconds>`, and `persist <key>` added for local database administration.

## Encryption and stored format

Client-side encryption uses AES-256-GCM with an authentication tag for new encrypted values. Older AES-256-CBC ciphertext is still readable. GCM ciphertext tampering is rejected. Keep encryption keys outside the database and source tree. Encryption is not a replacement for TLS.

New records use a compact envelope containing record flags, optional absolute expiration time, and payload. JSON and binary payloads are distinguished. Old JSON records without the envelope are decoded as non-expiring legacy records. TTL index rows are separate LevelDB keys and are removed atomically with normal replacement/deletion and by bounded cleanup. No destructive database migration is performed.

## Performance options

```ts
const db = await connect({
  ttl: { cleanupInterval: 1000, cleanupBatchSize: 500 },
  cache: { enabled: true, maxEntries: 10_000, ttl: 30_000 }
});
```

The cache is disabled by default and bounded when enabled. Writes, deletes, expiry changes, flush, and namespace flush invalidate affected entries; TTL is checked before returning cached data. `db.stats()` returns lightweight operation/cache/TTL counters. Cache performance depends on workload and should be measured before enabling it.

Run `npm run benchmark` for local, loopback gRPC, and encryption payload-size benchmarks. Run scripts directly to set sample counts, for example `node benchmark/local.cjs 10000`, `node benchmark/grpc.cjs 5000`, or `node benchmark/encryption.cjs 100`. They warm the database where applicable, exclude initialization from measured request latency, and report throughput, p50/p95/p99 latency, RSS delta, and process CPU time. The recorded baseline and post-change measurements are in [`benchmark/results.md`](benchmark/results.md); they show a local SET/GET regression and material encryption overhead for large values, so no general local speedup is claimed. Results depend on hardware, filesystem, Node.js version, and LevelDB compaction state; do not compare runs across unlike environments.

## Architecture

```text
Application
      │
      ├──────── Local API
      │
      └──────── gRPC / HTTP2
                    │
                    ▼
              Database Core
                    │
        ┌───────────┼───────────┐
        │           │           │
      Cache     TTL Engine   Batch Engine
        │           │           │
        └───────────┼───────────┘
                    │
                Record Codec
                    │
                  LevelDB
```

The local API and gRPC server call the same `DatabaseCore`. The server process is the only owner of its LevelDB instance; remote clients send operations over a persistent channel.

## Migration

New remote clients should migrate from `ssdiskdb://` REST/JSON-RPC URIs to `ssdiskdb+grpc://` gRPC URIs and enable TLS when crossing a trusted network boundary. The legacy HTTP endpoints and URI parsing are retained for compatibility. Local method names and existing exports remain; old LevelDB records are readable and no destructive key rewrite occurs. New GCM ciphertext can be read by upgraded versions; older package versions that only understand CBC cannot decrypt it, so upgrade all encrypted clients and servers together.

## Development checks

```bash
npm test
npm run build
npm run typecheck
```

License: Apache-2.0.

## Package identity and migration

The package in this repository is `@manojgowdain/ssdiskdb@0.1.0`. The unscoped `ssdiskdb` package is a separate existing npm package; this project does not deprecate or modify it. At the time this README was written, the scoped package had not been published to npm or JSR. Install from this repository or its release tarball until publication is announced. No LevelDB migration is required: the storage layout is unchanged by the package rename, and prior data remains readable.

The package supports Node.js ESM and CommonJS entrypoints. Deno can type-check and import the source API, and the JSR configuration passes a local dry run. **Local Deno persistence is not verified/supported on Windows:** Deno 2.4.5's Node compatibility runtime could not load `classic-level`'s native addon (Node ABI mismatch). Use Node.js for local LevelDB ownership. Deno can use the gRPC client against a Node-hosted SSDiskDB server; that path should be verified against the specific Deno version and platform before production use.

After the scoped release is available, the JSR import form is:

```ts
import { connect } from "jsr:@manojgowdain/ssdiskdb@0.1.0";
```

The code example shows the intended JSR specifier, not a currently published artifact. For local source checking, run `deno check mod.ts`; the parser smoke test requires `deno test --allow-env tests/deno_test.ts` because the imported gRPC dependency reads its logging environment variables.

## API availability

| API | Local Node | gRPC client/server | Notes |
|---|---:|---:|---|
| String set/get/delete/exists/incr | Yes | Yes | JSON values and Node Buffers |
| TTL set/expire/ttl/persist | Yes | Yes | Milliseconds; `ttl()` returns `-2`, `-1`, or remaining milliseconds |
| `mget` / `mset` / `mdelete` / `batch` | Yes | Yes | One remote RPC per bulk call; `batch` handles set/delete |
| Prefix scan / stream scan | Yes | Yes | Iterator-backed; stream scan is incremental |
| Hash `hset` / `hget` / `hdel` | Yes | Yes | Field API |
| Sorted Set `zset` / `zget` / `zdel` | Yes | Yes | No score-range API is currently exposed |
| Stats / flush | Yes | Yes | Flush and stats are exposed remotely |
| Dashboard / CLI | Yes | Dashboard routes | Dashboard remains HTTP; CLI name remains `ssdiskdb` |
| Deno local LevelDB | No on tested Windows/Deno combination | — | Native addon ABI mismatch; see limitation above |

The existing storage representation retains legacy record reads. New records use the versioned envelope described above; package renaming does not rewrite database files. The Hash and Sorted Set implementations retain their existing storage model, and the recorded benchmark currently shows slower local SET/GET than the pre-upgrade baseline. See [`docs/validation-report.md`](docs/validation-report.md) for the commands and measured results from this checkout.
