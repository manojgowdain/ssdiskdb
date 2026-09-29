# SSDiskDB

[GitHub](https://github.com/manojgowdain/ssdiskdb) ·
[npm](https://www.npmjs.com/package/@manojgowdain/ssdiskdb) ·
[JSR](https://jsr.io/@manojgowdain/ssdiskdb) ·
[Manoj Gowda](https://manojgowda.in/)

SSDiskDB is a disk-backed key-value database for Node.js. A local SSDiskDB
process owns a LevelDB database. Applications can use it in-process or connect
to a server over gRPC and HTTP/2 with Protocol Buffers. The library includes
string values, field-based Hash and Sorted Set APIs, persistent TTL, bulk
operations, prefix scans, optional bounded caching, client-side encryption, a
browser dashboard, authentication, namespaces, and a CLI.

This guide describes the published `@manojgowdain/ssdiskdb@0.1.0` API. For
current platform limitations and validation evidence, see
[Validation report](docs/validation-report.md). No destructive migration is
needed for existing LevelDB databases.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Connect options](#connect-options)
- [API reference](#api-reference)
- [TTL and expiration](#ttl-and-expiration)
- [Bulk operations and scans](#bulk-operations-and-scans)
- [Hash and Sorted Set operations](#hash-and-sorted-set-operations)
- [gRPC server and client](#grpc-server-and-client)
- [Authentication, authorization, and namespaces](#authentication-authorization-and-namespaces)
- [TLS and encryption](#tls-and-encryption)
- [Dashboard](#dashboard)
- [CLI reference](#cli-reference)
- [Storage format and compatibility](#storage-format-and-compatibility)
- [Performance, cache, and metrics](#performance-cache-and-metrics)
- [Deno and JSR](#deno-and-jsr)
- [Architecture](#architecture)
- [Migration and compatibility](#migration-and-compatibility)
- [Development and benchmarks](#development-and-benchmarks)

## Install

### Node.js / npm

```bash
npm install @manojgowdain/ssdiskdb
```

The package provides TypeScript declarations and both ESM and CommonJS
entrypoints.

```ts
import { connect } from "@manojgowdain/ssdiskdb";
```

```js
const { connect } = require("@manojgowdain/ssdiskdb");
```

The command-line executable remains `ssdiskdb`:

```bash
npx ssdiskdb --help
```

### Deno / JSR

```bash
deno add jsr:@manojgowdain/ssdiskdb@0.1.0
```

```ts
import { connect } from "jsr:@manojgowdain/ssdiskdb@0.1.0";
```

See [Deno and JSR](#deno-and-jsr) for the native LevelDB limitation observed on
Windows.

## Quick start

```ts
import { connect } from "@manojgowdain/ssdiskdb";

const db = await connect(); // Opens ./ssdb-local-db
try {
  await db.set("user:42", { name: "Manoj", active: true });
  const user = await db.get("user:42");
  console.log(user); // { name: "Manoj", active: true }
} finally {
  await db.close();
}
```

Pass a directory path to select a database location:

```ts
const db = await connect("./data/ssdiskdb");
```

Call `close()` when the process is finished with the client. It stops the TTL
worker, closes owned servers and then closes local LevelDB, or closes resources
held by the remote client.

## Connect options

The public factory is:

```ts
connect(pathOrOptions?: string | ConnectOptions, options?: ConnectOptions): Promise<SSDiskDBClient>
```

When the first argument is a string, it is either a storage path or a supported
connection URI. The optional second argument supplies extra options. When the
first argument is an object, pass the settings there.

| Option             | Type                | Default / use                                                                                   |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------- |
| `storagePath`      | `string`            | `./ssdb-local-db`; local LevelDB directory. Also accepts a supported connection URI.            |
| `encryptionKey`    | `string`            | No application-level encryption. Used for encrypted values on local or legacy HTTP connections. |
| `startDashboard`   | `boolean`           | `false`; start the dashboard for this client.                                                   |
| `dashboardPort`    | `number`            | `8971`; dashboard HTTP port.                                                                    |
| `remoteUrl`        | `string`            | No legacy HTTP connection. Example: `http://127.0.0.1:8971`.                                    |
| `grpcTarget`       | `string`            | No gRPC connection. Example: `127.0.0.1:8972`.                                                  |
| `apiKey`           | `string`            | Required for remote connections.                                                                |
| `serverId`         | `string`            | `Local`; registered remote client identity.                                                     |
| `grpcTls`          | TLS options object  | No TLS; accepts `rootCert`, `serverName`, and optional mTLS `privateKey`/`certChain`.           |
| `requestTimeoutMs` | `number`            | `5000`; gRPC unary RPC deadline.                                                                |
| `ttl`              | `TTLOptions`        | TTL cleanup defaults: 1000 ms interval and batch size 500.                                      |
| `cache`            | `CacheOptions`      | Disabled by default; optional bounded LRU cache.                                                |
| `startGrpcServer`  | `boolean`           | `false`; start a gRPC listener when opening a local DB.                                         |
| `grpc`             | `GrpcServerOptions` | Server bind/TLS/message/batch configuration.                                                    |

The TypeScript declarations also include `username` and `password` in
`ConnectOptions` for compatibility, but `connect()` does not consume those
fields. Use dashboard login or the `credentials` CLI command to manage dashboard
credentials.

## API reference

`connect()` returns an `SSDiskDBClient`. Unless noted, the methods below are
asynchronous and available on local and remote clients. Some management methods
are local-only; these differences are called out.

### String / key-value methods

| Method                      | Behavior                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `set(key, value, options?)` | Store a JSON-compatible value or Node `Buffer`; optional `{ ttl }`. Resolves to `1`.                                             |
| `get(key)`                  | Return the decoded value, or `undefined` if missing/expired.                                                                     |
| `del(key)`                  | Delete the key and its TTL index; resolves to `1`.                                                                               |
| `exists(key)`               | `true` for a live key, otherwise `false`.                                                                                        |
| `incr(key, amount?)`        | Add `amount` (default `1`) to the numeric value; a missing or non-numeric value starts at `0`. Resolves to the resulting number. |
| `expire(key, ttlMs)`        | Set or replace a String key's TTL. Returns `false` if it does not exist and `true` if expiration was set.                        |
| `ttl(key)`                  | Remaining milliseconds; `-2` means missing/expired, `-1` means no expiry, and `>= 0` is time remaining.                          |
| `persist(key)`              | Remove expiration from a String key. Returns `false` if missing or already persistent; otherwise `true`.                         |

`del()` returns `1` even if the key did not previously exist. TTL values use
milliseconds. A negative, infinite, or non-numeric TTL is rejected; `0` makes
the key immediately expired.

### Bulk and scan methods

| Method                 | Behavior                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `mget(keys)`           | Read multiple String keys in input order. Missing/expired items appear as `undefined`.                                                |
| `mset(entries)`        | Write multiple String keys in one LevelDB batch. Returns the number of unique keys written.                                           |
| `mdelete(keys)`        | Delete multiple String keys in one LevelDB batch. Duplicate input keys are deduplicated. Returns the number of unique keys requested. |
| `batch(operations)`    | Atomically apply String `set` and `delete` operations in one LevelDB batch. Returns the number of final unique-key operations.        |
| `scan(options?)`       | Fetch one bounded page of String records matching a prefix; returns `{ entries, cursor }`.                                            |
| `streamScan(options?)` | Async iterable of matching `{ key, value }` entries, fetched page by page.                                                            |

### Hash and Sorted Set methods

| Method                                | Behavior                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `hset(name, field, value, options?)`  | Set a Hash field value; accepts `{ ttl }` for this field record.              |
| `hget(name, field)`                   | Read one Hash field, or `undefined` when absent/expired.                      |
| `hdel(name, field)`                   | Delete one Hash field.                                                        |
| `zset(name, member, score, options?)` | Store a numeric score for a member; accepts `{ ttl }` for this member record. |
| `zget(name, member)`                  | Read the member score, or `undefined` when absent/expired.                    |
| `zdel(name, member)`                  | Delete one Sorted Set member.                                                 |

These are field/member access APIs. The current public API does not include
`hgetall`, `zrange`, score ordering/rank queries, or a score index. `expire()`,
`ttl()`, and `persist()` address String keys; Hash fields and Sorted Set members
can receive TTL through their `hset`/`zset` options but have no separate public
TTL query method.

### Management and lifecycle methods

| Method                                                        | Behavior and availability                                                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats()`                                                     | Snapshot runtime operation, byte, cache, expiration, and cleanup counters.                                                                                 |
| `getAllKeys()`                                                | Return all non-expired records as `{ key, value }[]`, including internal type prefixes. Materializes the full result; prefer `scan()` for large keyspaces. |
| `flush()`                                                     | Remove data and TTL-index records while retaining `config:` settings. This is destructive to stored application records.                                   |
| `startDashboard(port?)`                                       | Start a dashboard HTTP server; defaults to port `8971`.                                                                                                    |
| `startGrpcServer(options?)`                                   | Local client only. Start one gRPC server and return its bound address. Remote clients reject this method.                                                  |
| `setCredentials(username, passwordHash)` / `getCredentials()` | Local management methods for dashboard admin credentials. CLI hashes a new password before storing it. Remote clients do not support these methods.        |
| `close()`                                                     | Stop the client's owned services and release its resources.                                                                                                |

### Public exports

The package root exports `connect`, `parseConnectionString`, `DatabaseCore`, and
the declared public types `SSDiskDBClient`, `ConnectOptions`, `SetOptions`,
`MSetEntry`, `BatchOperation`, `ScanOptions`, and `ScanResult`. `connect()`
returns the client interface; its concrete local and remote client classes are
internal and are not exported from the package root. The Node ESM/CommonJS
package also has a default export object containing `connect`. The JSR/Deno
entrypoint exports the named API; it does not expose the Node default export.
Option interfaces referenced by `ConnectOptions` are accepted structurally as
nested objects even though they are not separately re-exported from the package
root.

## TTL and expiration

TTL is expressed in milliseconds and stored in the primary record. The absolute
expiration timestamp is encoded with the record, so `get()` can decide whether
it has expired from its primary read. A separate ordered index supports cleanup.

```ts
await db.set("session:123", { userId: 123, authenticated: true }, {
  ttl: 60_000,
});
console.log(await db.ttl("session:123"));

await db.expire("session:123", 30_000); // replace TTL
await db.persist("session:123"); // remove TTL
```

Semantics:

- `ttl(key) === -2`: key is absent or expired.
- `ttl(key) === -1`: key exists without expiration.
- `ttl(key) >= 0`: remaining TTL in milliseconds.
- `ttl: 0`: immediately expired.
- Negative or non-finite values throw a `RangeError`.
- Replacing a record without a TTL removes its previous expiration.
- Old records without TTL metadata remain persistent and readable.
- `set`, `hset`, and `zset` accept per-record `{ ttl }`.
- TTL data survives process restarts. Reads lazily remove expired records, and
  one background worker walks the ordered
  `ttl/<19-digit-expiresAt>/<fullDataKey>` index in bounded batches. It uses no
  per-key timers and stops during `close()`.

Configure cleanup on open:

```ts
const db = await connect({
  storagePath: "./data",
  ttl: {
    cleanupInterval: 1_000, // milliseconds between cleanup passes
    cleanupBatchSize: 500, // maximum index rows processed per pass
  },
});
```

## Bulk operations and scans

Bulk APIs reduce round trips and use LevelDB batch writes where applicable:

```ts
const count = await db.mset([
  ["user:1", { name: "Ada" }],
  { key: "user:2", value: { name: "Lin" }, ttl: 60_000 },
]);

const users = await db.mget(["user:1", "user:2", "missing"]);
await db.mdelete(["user:1", "user:2"]);

await db.batch([
  { type: "set", key: "config:theme", value: "dark" },
  { type: "set", key: "temp", value: "short-lived", ttl: 5_000 },
  { type: "delete", key: "old" },
]);
```

`MSetEntry` accepts either `[key, value]` or `{ key, value, ttl? }`. Tuple
entries do not take a TTL; use the object form when needed. A batch operation is
`{ type: "set", key, value, ttl? }` or `{ type: "delete", key }`. If the same
key occurs more than once, the last operation wins. Batches cover String keys
only.

Scan options are:

```ts
interface ScanOptions {
  prefix?: string; // defaults to ""
  limit?: number; // defaults to 100; valid range 1..5000
  cursor?: string | null;
}
```

```ts
const first = await db.scan({ prefix: "user:", limit: 100 });
console.log(first.entries); // [{ key: "user:1", value: ... }, ...]

if (first.cursor) {
  const next = await db.scan({
    prefix: "user:",
    limit: 100,
    cursor: first.cursor,
  });
  console.log(next.entries);
}

for await (const record of db.streamScan({ prefix: "user:", limit: 500 })) {
  await consume(record);
}
```

The cursor is opaque; pass it back unchanged. A `null` cursor means there are no
more pages. Scans use LevelDB ordered iterators and return logical String keys
without the storage type prefix. `scan()` collects only one page; `streamScan()`
fetches pages incrementally. `getAllKeys()` instead collects all records in
memory.

## gRPC server and client

gRPC is the primary remote application transport. It uses a persistent HTTP/2
channel and Protocol Buffers. A client reuses its channel for unary operations.
Batches are sent as one RPC and validated against the server's configured
operation limit. Stream scan writes records incrementally with stream
backpressure.

### Start a local server

```bash
npx ssdiskdb start --path ./data --port 8971 --grpc-port 8972
```

The CLI starts the dashboard on `8971` and the gRPC server on `8972`. The gRPC
server defaults to host `0.0.0.0` and insecure transport unless TLS credentials
are configured; protect the listener with TLS and network controls before
exposing it beyond a trusted development network.

### Register a server identity and connect

Register an address or chosen server ID in the database that owns the listener.
The CLI prints the generated API key once:

```bash
npx ssdiskdb server add app-server --path ./data
```

Connect using the exact registered ID and key:

```ts
import { connect } from "@manojgowdain/ssdiskdb";

const db = await connect("ssdiskdb+grpc://API_KEY@localhost:8972/app-server");
try {
  await db.set("order:123", { status: "ready" });
  console.log(await db.get("order:123"));
} finally {
  await db.close();
}
```

Equivalent options form:

```ts
const db = await connect({
  grpcTarget: "localhost:8972",
  apiKey: process.env.SSDISKDB_API_KEY!,
  serverId: "app-server",
  requestTimeoutMs: 5_000,
});
```

The client channel uses a 16 MiB message limit and 60-second keepalive by
default. The public `ConnectOptions` exposes the request deadline; it does not
expose client message-size or keepalive overrides. The server accepts
`maxMessageBytes` (default 16 MiB) and `maxBatchOperations` (default 1,000)
through the `grpc`/`startGrpcServer()` options. Exceeding the batch limit
returns gRPC `RESOURCE_EXHAUSTED`. Normal operations are unary RPCs;
`StreamScan` is server-streaming.

### RPC coverage

The versioned service is `ssdiskdb.v1.SSDiskDB`, defined in
[`proto/ssdiskdb.proto`](proto/ssdiskdb.proto). RPCs include:

- Handshake; Get, Set, Delete, Exists, Incr.
- Expire, TTL, Persist.
- MGet, MSet, MDelete, Batch.
- HashGet, HashSet, HashDelete.
- ZGet, ZSet, ZDelete.
- Scan, StreamScan, GetAllKeys, Stats, Flush.

The browser dashboard is still an HTTP interface. The legacy `ssdiskdb://`
HTTP/JSON-RPC remote client is retained for existing deployments; new
application clients should use `ssdiskdb+grpc://`.

## Authentication, authorization, and namespaces

Each gRPC request carries metadata:

```text
authorization: Bearer <API_KEY>
x-ssdiskdb-server-id: <SERVER_ID>
```

The server validates the API key against the registered server identity or
connecting peer address before performing an operation. Handshake uses the same
authorization check. A non-`Local` server ID receives a scoped client: String
keys are stored under `client:<serverId>:` and Hash/Sorted Set namespaces are
scoped as well. `Local` is a special registered identity that accesses the
unscoped database. Keep its credentials restricted to trusted administrators.

Manage allowed server/client identities with:

```bash
npx ssdiskdb server add app-server --path ./data
npx ssdiskdb server list --path ./data
npx ssdiskdb server remove app-server --path ./data
```

An unregistered identity is denied. Removing a registration revokes access but
does not delete that identity's stored namespace. `flush()` on an authorized
scoped client flushes only that namespace; `flush()` on a local/admin client
clears application data while preserving configuration.

The dashboard also supports an administrator account and `junior`/`senior`
subaccounts. Dashboard role permissions apply to dashboard routes;
API-key/server registration controls remote database access. These are separate
authentication surfaces.

## TLS and encryption

### gRPC TLS

Without TLS, gRPC uses insecure channel credentials. TLS is independent from
client-side value encryption.

Server TLS configuration uses `privateKey` and `certChain`; the server also
accepts `rootCert` and `requireClientCertificate` for mutual TLS:

```ts
import { readFileSync } from "node:fs";

const db = await connect({ storagePath: "./data" });
const address = await db.startGrpcServer({
  host: "0.0.0.0",
  port: 8972,
  privateKey: readFileSync("server-key.pem"),
  certChain: readFileSync("server-cert.pem"),
  rootCert: readFileSync("client-ca.pem"),
  requireClientCertificate: true,
});
```

Client TLS configuration uses `grpcTls`:

```ts
import { readFileSync } from "node:fs";

const db = await connect({
  grpcTarget: "db.example.com:8972",
  apiKey: process.env.SSDISKDB_API_KEY!,
  serverId: "app-server",
  grpcTls: {
    rootCert: readFileSync("server-ca.pem"),
    serverName: "db.example.com",
    privateKey: readFileSync("client-key.pem"), // for mTLS
    certChain: readFileSync("client-cert.pem"), // for mTLS
  },
});
```

`GrpcTlsClientOptions` fields are `rootCert`, `privateKey`, `certChain`, and
optional `serverName`. `GrpcServerOptions` fields are `host`, `port`,
`privateKey`, `certChain`, `rootCert`, `requireClientCertificate`,
`maxMessageBytes`, and `maxBatchOperations`. Provide certificates through a
secret manager or protected files; do not commit keys into source control.

### Application-level encryption

Pass `encryptionKey` on a local or legacy HTTP connection, or use the encrypted
gRPC URI:

```ts
const encrypted = await connect(
  "ssdiskdb+grpc+encry://API_KEY@db.example.com:8972/app-server?key=APP_SECRET",
  { grpcTls: { rootCert: readFileSync("server-ca.pem") } },
);
```

The encrypted gRPC URI is
`ssdiskdb+grpc+encry://API_KEY@HOST:PORT/SERVER_ID?key=SECRET`. The API key
authenticates the RPC; the `key` query value encrypts application values and is
not used as the Bearer credential. Prefer the options form with secrets from
environment/secret storage for deployments, because URI strings can appear in
logs and process listings.

New String payloads use AES-256-GCM authenticated encryption. Older AES-256-CBC
string ciphertext remains readable. Binary values use an authenticated binary
envelope. Encryption protects values at the application layer; TLS protects the
network channel. Never reuse a sample key as a production secret.

## Dashboard

Start the dashboard from code:

```ts
const db = await connect({
  storagePath: "./data",
  startDashboard: true,
  dashboardPort: 8971,
});
```

Or use the CLI:

```bash
npx ssdiskdb start --path ./data --port 8971
```

Open `http://localhost:8971`. The CLI currently reports the default dashboard
login as `manoj` / `manoj`; change it before exposing the dashboard. Update
credentials with:

```bash
npx ssdiskdb credentials --username admin --password "use-a-unique-password" --path ./data
```

The dashboard provides database inspection/search, key get/set/delete, flush,
server registration, client/subaccount management, authentication, and RBAC. The
browser communicates with the dashboard HTTP layer; it does not connect directly
to LevelDB. Remote-mode dashboards proxy through the remote client. Dashboard
administration is not the same transport as application gRPC.

## CLI reference

The executable is `ssdiskdb` for both the scoped npm package and existing
scripts.

```text
ssdiskdb start [--path PATH] [--port PORT] [--grpc-port PORT]
ssdiskdb start --grpc HOST:PORT --apiKey KEY --serverId ID
ssdiskdb start --remote URL --apiKey KEY --serverId ID
ssdiskdb credentials --username NAME --password PASSWORD [--path PATH]
ssdiskdb server add ADDRESS [API_KEY] [--path PATH]
ssdiskdb server remove ADDRESS [--path PATH]
ssdiskdb server list [--path PATH]
ssdiskdb subaccount create --username NAME --password PASSWORD [--role junior|senior] [--path PATH]
ssdiskdb subaccount remove USERNAME [--path PATH]
ssdiskdb subaccount list [--path PATH]
ssdiskdb ttl KEY [--path PATH]
ssdiskdb expire KEY MILLISECONDS [--path PATH]
ssdiskdb persist KEY [--path PATH]
```

`start` without a remote option opens the local database and launches the
dashboard and gRPC listener. `--uri URI` or a positional
`ssdiskdb://`/`ssdiskdb+grpc://` URI can also select remote mode. Use `--help`
for the installed executable's complete usage text.

## Storage format and compatibility

LevelDB remains the storage engine, and the server process is the only owner of
its database. Existing databases open without destructive migration. Existing
legacy JSON records without TTL metadata are treated as persistent records. New
record envelopes carry a version/flags byte, optional expiration timestamp, and
encoded payload. TTL index rows are ordered by timestamp and updated with their
records in LevelDB batches.

Logical data prefixes are preserved:

```text
s:<string-key>
h:<hash-name>:<field>
z:<sorted-set-name>:<member>
```

Remote non-`Local` clients use the `client:<serverId>:` namespace. The TTL index
uses `ttl/<19-digit-absolute-expiration>/<full-data-key>`. This index supports
bounded background cleanup without loading all expiring keys into memory.

Values are JSON serialized by default; Node `Buffer` values are stored as
binary. Legacy unframed JSON values remain readable. A record written with the
new GCM string encryption cannot be decrypted by old releases that only support
CBC, so coordinate encrypted-client upgrades.

## Performance, cache, and metrics

### Cache

Caching is disabled by default. Enable a bounded LRU cache explicitly:

```ts
const db = await connect({
  cache: {
    enabled: true,
    maxEntries: 10_000,
    ttl: 30_000, // optional maximum cache residence in ms; 0 means no extra cache TTL
  },
});
```

`maxEntries` defaults to 10,000 when enabled and is clamped to at least one. The
cache stores decoded-record payload bytes, refreshes LRU recency on hits,
respects record expiration, and is invalidated by writes, deletes, TTL changes,
flushes, and namespace flushes. It is a performance aid only; it is bounded and
correctness does not depend on it. Measure the workload before enabling it.

### Batching and scans

Use `mset`, `mdelete`, or `batch` to apply multiple updates through one LevelDB
batch. Use `mget` for multiple values. Use prefix `scan` or `streamScan` rather
than `getAllKeys()` for large datasets. gRPC batch requests are one RPC and are
bounded by `maxBatchOperations`.

### Runtime statistics

`await db.stats()` returns a `StatsSnapshot`:

| Field                                     | Meaning                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `reads`, `writes`, `deletes`              | Counted database operations.                                                                          |
| `expiredKeys`                             | Records lazily or asynchronously removed after expiration.                                            |
| `cacheHits`, `cacheMisses`                | Cache lookup results.                                                                                 |
| `operationsPerSecond`                     | Current runtime's recent per-second operation counter.                                                |
| `activeConnections`                       | Active connection count when supplied by the caller (the local core snapshot currently reports zero). |
| `bytesRead`, `bytesWritten`               | Counted payload bytes.                                                                                |
| `ttlCleanupRuns`, `ttlCleanupKeysDeleted` | TTL background cleanup activity.                                                                      |

Metrics are in-memory counters for the process lifetime; they are not persisted.
`stats()` is a lightweight snapshot, not a database-wide recount.

### Benchmarks and performance claims

The [`benchmark/`](benchmark/) scripts measure local API, gRPC, and encryption
workloads and report latency percentiles, throughput, CPU time, and RSS deltas.
[`benchmark/results.md`](benchmark/results.md) records measured baseline and
post-change values. The recorded baseline comparison shows lower local SET/GET
throughput after the record-envelope and TTL changes; SSDiskDB does not claim a
general speedup. Benchmark numbers vary with hardware, OS, filesystem, payload,
concurrency, and LevelDB state.

## Deno and JSR

The package is published at [JSR](https://jsr.io/@manojgowdain/ssdiskdb). The
source entrypoint passes `deno check`, and the published
`jsr:@manojgowdain/ssdiskdb@0.1.0` entrypoint also passed a Deno type check in
the validation environment.

**Local Deno persistence has a known platform limitation:** on Windows with Deno
2.4.5, LevelDB's `classic-level` native addon did not load because no compatible
Node ABI build was available. The local database integration test therefore
could not run under Deno in that environment. Use Node.js for local LevelDB
ownership. This repository has not verified Deno gRPC client runtime behavior
across platforms; test against your chosen Deno version and OS before relying on
it.

The Deno smoke test imports the public source and parses a gRPC URI. It uses
`--allow-env` because the imported gRPC dependency reads logging environment
variables:

```bash
deno check jsr:@manojgowdain/ssdiskdb@0.1.0
deno test --allow-env tests/deno_test.ts
```

## Architecture

```text
Application
      │
      ├──────── Local API ───────────────┐
      │                                  │
      └──────── gRPC / HTTP2 ──┐         │
                               ▼         ▼
                         Database Core
                               │
                  ┌────────────┼────────────┐
                  │            │            │
                Cache      TTL Engine   Batch Engine
                  │            │            │
                  └────────────┼────────────┘
                               │
                          Record Codec
                               │
                             LevelDB
                               │
                              SSD
```

Local clients and the gRPC server use the same database core. Remote clients
reuse an HTTP/2 channel. The dashboard uses the server-side HTTP layer. LevelDB
is not exposed directly to browsers or remote application processes.

## Migration and compatibility

### Package name

Install the scoped package with `npm install @manojgowdain/ssdiskdb` or import
it from JSR. The old unscoped npm package `ssdiskdb` remains a separate package;
this project does not rename or deprecate it. Existing local imports can be
migrated by changing the package specifier and keeping the same `connect()` and
database methods.

### Remote transport

Use `ssdiskdb+grpc://` for new remote applications. Existing `ssdiskdb://` and
`ssdiskdb+encry://` HTTP/JSON-RPC connection URIs remain accepted for
compatibility. `ssdiskdb+grpc+encry://` selects gRPC plus application-level
value encryption. URI parsing does not automatically convert legacy HTTP URIs to
gRPC.

### Existing databases and encrypted data

Existing LevelDB paths and data remain readable; no destructive key rewrite is
performed. Legacy records without TTL continue to have no expiration. The new
record codec reads old JSON records. Old package releases that only understand
AES-CBC cannot decrypt new AES-GCM values, so upgrade encrypted clients and
servers together.

## Development and benchmarks

```bash
npm install
npm test
npm run typecheck
npm run build
deno check mod.ts
deno test --allow-env tests/deno_test.ts
deno publish --dry-run --allow-dirty
```

There is no `npm run lint` script in the current package. Deno formatting and
lint checks used for this repository are:

```bash
deno fmt --check deno.json jsr.json mod.ts tests/deno_test.ts
deno lint mod.ts tests/deno_test.ts
```

Run benchmark scripts after building:

```bash
npm run build
node benchmark/local.cjs 2000
node benchmark/grpc.cjs 500
node benchmark/encryption.cjs 100
```

`local.cjs` covers String, bulk, TTL, scan, Hash, and Sorted Set calls.
`grpc.cjs` covers unary calls, batch, and scan pages on loopback.
`encryption.cjs` measures plain and encrypted payloads at multiple sizes.
Initialization is excluded from measured request latency; warm-up, sample count,
OS/CPU, memory deltas, and percentiles should be included when comparing runs.
Do not compare measurements from different machines as a controlled before/after
result.

## Links and license

- [Source and issues](https://github.com/manojgowdain/ssdiskdb)
- [npm package](https://www.npmjs.com/package/@manojgowdain/ssdiskdb)
- [JSR package](https://jsr.io/@manojgowdain/ssdiskdb)
- [Author website](https://manojgowda.in/)
- [Apache License 2.0](LICENSE)
