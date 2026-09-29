# SSDiskDB Package and Runtime Validation

Run date: 2026-09-29. This report records the scoped package and cross-runtime verification performed in this checkout. This validation session did not publish packages; the scoped packages appeared in the registries afterward and their current published metadata was checked.

## Package identity and registry status

- npm manifest and lockfile: `@manojgowdain/ssdiskdb@0.1.0`, `Apache-2.0`.
- JSR metadata: same name, version, license, and `mod.ts` entrypoint.
- Existing npm `ssdiskdb@1.1.0` still resolves and is not marked deprecated.
- `npm view @manojgowdain/ssdiskdb` now resolves version `0.1.0`, Apache-2.0, and its tarball URL.
- JSR metadata now resolves `@manojgowdain/ssdiskdb@0.1.0` (created 2026-09-29); `deno check jsr:@manojgowdain/ssdiskdb@0.1.0` passes.
- The expanded repository README is the current documentation on GitHub. npm and JSR render the README snapshot from their published `0.1.0` package; a later package release is required for these README additions to appear on the registry pages.
- The registry package metadata points at the prior `ManojGowda89` GitHub URL; this repository updates its canonical links to the user-provided `manojgowdain` URL.
- CLI executable remains `ssdiskdb`. Package rename changes no database path, key encoding, or record format.

## Commands and results

| Check | Result |
|---|---|
| `npm test` | Pass: 13 integration tests and 8 upgrade/regression tests (21 total) |
| `npm run typecheck` | Pass |
| `npm run build` | Pass; emits ESM and CommonJS trees |
| Node package entrypoint tests | Pass: CJS and ESM each opened a temporary DB and exercised set/get/exists/TTL/delete |
| Isolated npm tarball consumer | Pass: ESM, CommonJS, TypeScript declaration resolution, CLI `--help`, and protobuf asset |
| `deno check mod.ts` | Pass |
| `deno test --allow-env tests/deno_test.ts` | Pass: parser/entrypoint smoke test, 1 test |
| `deno fmt --check deno.json jsr.json mod.ts tests/deno_test.ts` | Pass |
| `deno lint mod.ts tests/deno_test.ts` | Pass |
| `deno publish --dry-run --allow-dirty` | Pass; filtered to LICENSE, README, deno.json, mod.ts, proto schema, and `src/**/*.ts` |
| `npm run lint` | Not available: package has no `lint` script |
| Deno local LevelDB integration | Not supported on tested Windows/Deno runtime; see limitation below |

The temporary npm consumer installs only the packed tarball plus its declared dependencies and removes its temporary project in `finally`. No npm or JSR publish command was run.

## Deno storage limitation

The Deno source graph type-checks and the exported parser runs under Deno. Attempting to open a local database on Windows failed before a database operation: `classic-level` could not load a native build for Deno's Node compatibility ABI (reported `runtime=node abi=108`, while the Deno runtime identified itself as Node 24.2.0). A direct LevelDB probe terminated at `open()` with Windows exit status `-1066598273`. The Deno integration test is consequently a source/API smoke test, not a passing Deno persistence test. Use Node.js for local LevelDB databases. The gRPC client runtime was not separately exercised under Deno.

The JSR entrypoint re-exports the named public API. The package's Node entrypoints also preserve the existing default export. JSR's slow-type validation rejected attempting to re-export that default, so default-export parity is not claimed for the Deno/JSR source entrypoint.

## npm package contents and module formats

`npm pack` produced `manojgowdain-ssdiskdb-0.1.0.tgz` (121.8 kB compressed, 802.6 kB unpacked, 90 files). It includes both `dist/esm` and `dist/cjs`, declarations, the CLI, and `proto/ssdiskdb.proto`. The isolated consumer loaded both module formats by package name, compiled a consumer TypeScript file, and ran the installed CLI help command.

TypeScript source now uses explicit Node built-in specifiers and imports `Buffer` from `node:buffer`. The ESM and CommonJS builds rewrite relative `.ts` source imports to `.js`; nested package markers let Node interpret both output trees correctly. Level is dynamically imported only when opening a local database, avoiding native storage initialization when importing the source API for Deno tooling.

## Benchmarks

Environment: Windows x64, Node.js 20.19.4, 12th Gen Intel Core i5-12450H, local workspace filesystem. These are one short run with 1,000 local operations, 200 gRPC unary operations, and 20 encryption samples per payload. Warm-up/initialization are excluded by the scripts. Tail percentiles on the 20-sample payload series and two 100-op batch samples are noisy and should not be treated as stable capacity measurements.

| Operation | ops/s | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|
| Local SET object | 10,060 | 0.0940 | 0.1492 | 0.2467 |
| Local GET object | 11,168 | 0.0812 | 0.1158 | 0.2435 |
| Local EXISTS | 14,636 | 0.0625 | 0.1021 | 0.2234 |
| Local MSET 100 (10 samples) | 513 batches/s | 1.9992 | 2.8436 | 2.8436 |
| Local MGET 100 (10 samples) | 1,254 batches/s | 0.7821 | 2.2769 | 2.2769 |
| Local TTL set | 8,008 | 0.1191 | 0.2042 | 0.4266 |
| Local scan page 100 (20 samples) | 3,348 pages/s | 0.2861 | 0.5818 | 0.5818 |
| gRPC SET | 867 | 1.0749 | 1.8612 | 2.7506 |
| gRPC GET | 770 | 1.1733 | 2.2058 | 3.4828 |
| gRPC batch 100 (2 samples) | 163 batches/s | 7.6333 | 7.6333 | 7.6333 |
| gRPC scan page 100 (20 samples) | 308 pages/s | 2.9558 | 6.6910 | 6.6910 |

The prior larger run recorded in [`../benchmark/results.md`](../benchmark/results.md) compared pre-upgrade and post-upgrade local workloads and found lower SET/GET throughput after record envelopes and TTL work. The short run above also has substantially different throughput, confirming sensitivity to sample size and system state. No speedup is claimed. These checks do not cover 100K/1M database sizes, 500-way concurrency, or stable production tail latency.

## Behavior and remaining limits

- The existing full test suite passed, including API-key handling, dashboard session auth/RBAC, namespace routing, encryption, persistence, gRPC channel reuse, TLS/mTLS, TTL, batches, scans, cache invalidation, and legacy record reads.
- The isolated npm consumer verifies package-name resolution and packaged runtime assets. The scoped package is published at `0.1.0`; README changes made after that release are not included in its registry snapshot.
- Hash and Sorted Set APIs remain the existing `hset`/`hget`/`hdel` and `zset`/`zget`/`zdel` field interfaces; no new range-ranking API is asserted.
- The benchmark suite is reproducible but not a multi-run capacity study. Full matrix sizes/concurrency, memory ceilings under sustained load, and before/after REST-vs-gRPC comparisons were not run here.
- Coverage reporting is not configured in this repository. There is no npm lint script; Deno formatting/lint checks cover only the source entrypoint smoke files and Deno config.
