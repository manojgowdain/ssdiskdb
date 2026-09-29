# SSDiskDB Verification and README Alignment Design

## Goal

Verify the behavior implemented in the current SSDiskDB checkout, fix reproducible defects within its existing product scope, and update the README so it describes the verified public API and operational behavior accurately.

## Current implementation baseline

The package source currently exports `connect`, `parseConnectionString`, `SSDiskDBClient`, and `ConnectOptions`. The client surface includes string operations (`set`, `get`, `del`, `exists`, `incr`), hash-field operations (`hset`, `hget`, `hdel`), sorted-set member storage (`zset`, `zget`, `zdel`), lifecycle/dashboard configuration, `getAllKeys`, `flush`, and dashboard credential methods. Local storage uses LevelDB. Remote mode is HTTP JSON RPC implemented by the dashboard server, with API-key/server registration and server-specific key prefixes. The package contains no gRPC service or protobuf definitions. TTL, LRU cache, and metrics code exists under `src/core/`, but the current public client implementation does not wire those modules into its operations.

The repository already has a `node:test` suite in `test.js`; `package.json` currently defines `build` and `test`, but no lint, typecheck, or benchmark scripts. Existing working-tree edits in `package.json`, `package-lock.json`, `.claude/`, and `src/core/` are user state and must be preserved.

## Scope

1. Inspect source, package metadata, existing tests, dashboard routes, CLI, and README to establish the actual API and behavior.
2. Create a feature matrix using only capabilities found in implementation. Distinguish public client APIs from dashboard/CLI features and internal modules. Mark local and remote support based on the actual routing code.
3. Execute existing verification commands and focused end-to-end checks using isolated temporary paths/ports. Expand the existing test structure to cover implemented operations, persistence, remote authentication/namespace behavior, encryption, dashboard authentication/RBAC, CLI entry points, and failure cases where practical.
4. Fix only reproducible defects in features already implemented. Add regression coverage and rerun relevant checks. Do not introduce claimed-but-absent subsystems (such as gRPC, public TTL, batch, or scan APIs) as part of this audit.
5. Run available build/test/package checks and existing benchmarks only when such scripts or benchmark code exist. Report unavailable categories explicitly instead of inventing results.
6. Rewrite `readme.md` after verification. Document actual installation, exports, signatures, local and HTTP remote connection behavior, dashboard/CLI, security boundaries, serialization/storage compatibility, and verified examples. Omit unsupported gRPC/TLS/TTL/cache/batch/scan claims.
7. Produce a test report with actual pass/fail/skip counts, duration, commands, and any limits. Do not fabricate benchmark, coverage, or performance results.

## Testing and isolation

All test databases must be created under temporary directories or uniquely named temporary paths and closed/removed in cleanup paths. Tests must assert returned values and persisted state, not merely symbol presence. The existing suite uses real LevelDB and an in-process HTTP dashboard; preserve that integration style. Never target a user database. Do not add broad mocks for storage or transport integration.

## Documentation principles

The README is generated from the verified exports, implementation branches, and test observations. It must clearly distinguish local LevelDB use from the HTTP remote client/server behavior and must not claim gRPC transport, native public TTL, public cache configuration, batch operations, scan cursors, TLS termination behavior, or performance figures unless source and tests establish them. Compatibility statements must be limited to storage behavior verified by the source and tests; unknown migration history should be stated as unknown.

## Acceptance criteria

- A source-derived feature matrix exists in the repository and reports support separately for local client, HTTP remote client, CLI, and dashboard when applicable.
- Tests cover the currently implemented public operations and principal dashboard/remote security paths, with isolated data and deterministic cleanup.
- Any reported implementation fix has a regression test; the complete available test and build commands are rerun after fixes.
- The README matches exported signatures and verified behavior, includes working examples that were exercised, and removes unsupported product claims.
- Final reporting includes changed files, verified commands and outcomes, test counts/duration where available, benchmark/coverage availability, compatibility limits, and remaining issues.

## Out of scope

Implementing gRPC/protobuf, adding public TTL/batch/scan/cache APIs, redesigning authentication or encryption, adding new benchmark infrastructure, or making performance guarantees. Those would require separate feature designs because they change the product architecture and public API.
