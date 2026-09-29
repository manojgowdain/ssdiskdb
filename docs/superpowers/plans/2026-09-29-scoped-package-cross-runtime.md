# Scoped Package and Cross-Runtime Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a locally verifiable `@manojgowdain/ssdiskdb@0.1.0` package with accurate npm, Node.js, Deno, and JSR entry points while retaining SSDiskDB's existing API, data format, and CLI command.

**Architecture:** Keep the current database core and LevelDB implementation as the single source of behavior. Add a real public `mod.ts`, make shared imports valid for Deno and emitted Node modules, use npm conditional exports for the compiled package, and narrowly filter JSR files. If the existing `level` or gRPC dependency stack cannot run under Deno, report that exact boundary rather than creating a second backend.

**Tech Stack:** TypeScript 5.9, Node.js, Deno 2, `level`, `@grpc/grpc-js`, `@grpc/proto-loader`, Node's built-in test runner, npm pack, Deno publish dry-run.

**Spec:** `docs/superpowers/specs/2026-09-29-package-rename-deno-jsr-design.md`

## Global Constraints

- New package name: `@manojgowdain/ssdiskdb`.
- New scoped package version: `0.1.0`.
- License metadata: `Apache-2.0`, matching the repository `LICENSE`.
- Leave the published `ssdiskdb` package untouched and do not claim it is deprecated.
- Keep the `ssdiskdb` CLI executable, database key prefixes, protocol names, and public local APIs compatible.
- Do not publish to npm or JSR and do not access production databases.
- Include the protobuf schema in the npm/JSR runtime package where the gRPC implementation requires it.
- Keep tests isolated in temporary storage paths and remove temporary consumer projects after validation.

## Review Focus

- TypeScript import rewriting must resolve for Deno source and both emitted Node formats; prove with runtime imports, not `tsc` alone.
- `mod.ts` must export only actual public symbols and must not resolve to an empty or Node-only module accidentally.
- Deno must open a temporary LevelDB and exercise data operations; a passing empty-module check is not evidence.
- npm tarball exports must point to files present in the tarball, including `proto/ssdiskdb.proto`.
- JSR publish dry-run must not include `.claude`, databases, node_modules, `dist`, tests, benchmarks, or unrelated deployment assets.

---

### Task 1: Align package identity and manifests

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `deno.json`
- Modify: `jsr.json`
- Modify: relevant project examples and links in `README.md`, `src/dashboard.ts`, `index.html`, and test/benchmark import strings
- Test: `tests/package-metadata.test.js` (create)

**Interfaces:**
- Produces package metadata for npm and JSR with name `@manojgowdain/ssdiskdb`, version `0.1.0`, and license `Apache-2.0`.
- Preserves the CLI bin name `ssdiskdb` and internal storage/protocol strings.

- [x] **Step 1: Add metadata regression tests** asserting the npm and JSR manifests agree on scoped name/version/license; assert the CLI bin remains `ssdiskdb` and root LICENSE remains Apache-2.0.
- [x] **Step 2: Run `node --test tests/package-metadata.test.js` and confirm it fails against current `package.json`/`mod.ts` metadata.**
- [x] **Step 3: Change npm package identity/version/license and synchronize the lockfile with `npm install --package-lock-only --ignore-scripts`; leave the conditional export map for Task 2, after output paths are verified.**
- [x] **Step 4: Make `deno.json` and `jsr.json` agree on package identity/version/license and add only required npm dependency mappings and publication filters.**
- [x] **Step 5: Update import examples and package URLs selectively. Keep `ssdiskdb` in the CLI executable, local database folder, gRPC service, protobuf package, and old package migration instructions.**
- [x] **Step 6: Run the metadata test and `npm ls --depth=0`; verify dependency versions and existing workspace changes remain intact.**

### Task 2: Build a valid shared public entry point for Node, Deno, and JSR

**Files:**
- Modify: `mod.ts`
- Modify: `src/index.ts`, `src/core/*.ts`, `src/grpc/*.ts`, and `src/dashboard.ts` local imports only as required
- Modify: `tsconfig.json`, `tsconfig.cjs.json`
- Modify: `package.json` export map and `files`
- Test: `tests/runtime-entrypoints.test.js` (create)
- Test: `tests/deno_test.ts` (create)

**Interfaces:**
- `mod.ts` exports the same public entry point as `src/index.ts`: `connect`, `parseConnectionString`, `DatabaseCore`, `LocalSSDBClient`, and public option/API types, plus the existing default export.
- Node package exports resolve types, ESM, and CommonJS only when the corresponding emitted files load successfully.

- [x] **Step 1: Add a Node test that imports public names from built ESM and CommonJS outputs and opens a temporary database.** Assert exact set/get/delete/TTL results.
- [x] **Step 2: Run the entrypoint test and record the current ESM resolution failure.**
- [x] **Step 3: Add `.ts` extensions to source-relative imports and configure TypeScript's relative import rewrite so emitted Node code references `.js` files. Change built-in imports such as `crypto` to `node:crypto`.**
- [x] **Step 4: Implement `mod.ts` as explicit public re-exports; do not export core internals such as codec, cache, metrics, or auth helpers.**
- [x] **Step 5: Add Deno npm mappings for runtime packages and run `deno check mod.ts`. Add any needed `nodeModulesDir` configuration only when demonstrated by Deno diagnostics.**
- [x] **Step 6: Attempt a Deno local-store integration, preserve the native LevelDB ABI failure, and narrow the passing Deno suite to source/API checking rather than introducing another backend.**
- [x] **Step 7: Add npm conditional exports for `types`, `import`, `require`, and `default` pointing only to built artifacts. Set `files` to the outputs and protobuf asset actually used by runtime.**
- [x] **Step 8: Run `npm run build`, `npm run typecheck`, the runtime entrypoint test, `deno check mod.ts`, and the passing Deno source test.**

### Task 3: Validate JSR publish surface and add runtime feature matrix

**Files:**
- Modify: `jsr.json`, `deno.json`
- Create: `docs/feature-matrix.md`
- Test: `tests/deno_test.ts`

**Interfaces:**
- JSR exposes only the default public module entry point; package files are restricted to source dependencies, `mod.ts`, README, LICENSE, config, and runtime assets actually required by the exported API.
- Matrix columns: Feature, Local, gRPC, CLI, Dashboard, npm, Deno/JSR, Tested.

- [x] **Step 1: Build matrix rows only for real methods/RPCs discovered in `src/index.ts`, `src/grpc/server.ts`, `src/cli.ts`, and `src/dashboard.ts`. Mark support only when an integration test covers it.**
- [x] **Step 2: Set JSR publish filters that exclude `.claude`, `.github`, databases, `node_modules`, `dist`, tests, benchmarks, scratch examples, and unrelated deploy files. Include the proto file only if gRPC remains in the Deno public entry/runtime.**
- [x] **Step 3: Run `deno publish --dry-run --allow-dirty`; inspect every listed file and confirm no out-of-scope content appears.**
- [x] **Step 4: Run `deno fmt --check` and `deno lint` on Deno source/config/tests, fixing real diagnostics rather than suppressing broad lint rules.**
- [x] **Step 5: Check scoped JSR registry availability; report local validation separately from registry publication and do not publish.**

### Task 4: Build and install an npm tarball in an isolated consumer

**Files:**
- Modify: `tests/package-consumer.ps1` (create)
- Modify: `package.json`, `package-lock.json` only if tarball verification uncovers packaging defects

**Interfaces:**
- Consumer imports the scoped package using Node ESM syntax and TypeScript types; CJS is tested only if included in `exports`.
- Consumer covers local database open, set/get/delete/TTL, and CLI startup/help.

- [x] **Step 1: Create a PowerShell consumer test using a unique temporary directory and `try/finally` cleanup. Run `npm pack --pack-destination <temp>` from the repository.**
- [x] **Step 2: Install the tarball into the consumer and add `consumer.mjs` using `import { connect } from "@manojgowdain/ssdiskdb"`; exercise a temporary database and assert values.**
- [x] **Step 3: Add a TypeScript consumer fixture and run `npx tsc --noEmit` to prove declaration resolution.**
- [x] **Step 4: Run the packaged CLI with `--help` and confirm the protobuf schema is present in the tarball.**
- [x] **Step 5: Inspect `npm pack --dry-run --json`; assert runtime assets exist and no databases, tests, secrets, or development-only folders ship.**
- [x] **Step 6: Run the consumer script and clean the temporary project in `finally`, including on failure.**

### Task 5: Expand real tests for existing feature behavior and runtime compatibility

**Files:**
- Create: `tests/deno_test.ts`
- Create: `tests/package-metadata.test.js`
- Create: `tests/runtime-entrypoints.test.js`
- Modify: `package.json` test scripts only after test paths are established
- Existing suites: `test.js`, `test-upgrade.js`

**Interfaces:**
- Tests call the public client and inspect LevelDB batches/iterators only when asserting architecture, not instead of observable behavior.
- Existing Node suites remain unchanged in expected semantics.

- [ ] **Step 1: Add public API tests for scalar/object/array/binary values, overwrite, missing keys, and deletion to the new Node test file.**
- [ ] **Step 2: Add TTL restart, zero/negative TTL, replacement/persist, namespace separation, and bounded cleanup tests using temporary databases. Reuse existing passing cases instead of duplicating long sleeps unnecessarily.**
- [ ] **Step 3: Add namespace API tests for set/get/delete/exists/TTL/batch/scan and Hash/Sorted Set methods that actually exist. Do not invent ZRANGE/HGETALL APIs.**
- [ ] **Step 4: Add gRPC assertions for all implemented protobuf methods, unauthorized metadata, namespace isolation, reconnect after server restart, deadlines, TLS/mTLS, binary encryption, and graceful close.**
- [ ] **Step 5: Add cache tests for max entries, disabled mode, hit/miss, write/delete/flush invalidation, TTL behavior, and no stale reads.**
- [ ] **Step 6: Add architecture assertions that LevelDB batch operations call native batch/write paths and scans paginate through iterators without invoking `getAllKeys`.**
- [ ] **Step 7: Run the full Node suite and Deno suite; fix root causes and retain regression tests.**

### Task 6: Verify compatibility, benchmarks, and README after implementation

**Files:**
- Rewrite: `README.md`
- Modify: `benchmark/` only for reproducibility defects
- Create: `docs/validation-report.md`

**Interfaces:**
- README examples use only APIs verified in prior tasks.
- Report separates npm tarball, local Deno source, JSR dry-run, and published registry status.

- [x] **Step 1: Run repository tests, Node build/typecheck, Deno check/test/fmt/lint, JSR dry-run, npm tarball consumer, and existing benchmark scripts.** Do not invoke nonexistent scripts.
- [x] **Step 2: Record actual run counts, durations, benchmark CPU/OS/Node and operation percentiles, npm registry status, JSR status, and coverage status.** State coverage not configured if no coverage tool exists.
- [x] **Step 3: Write README package migration instructions: old `npm i ssdiskdb`, new `npm i @manojgowdain/ssdiskdb`; state the old package's verified current status without claiming deprecation.**
- [x] **Step 4: Add verified Node/npm and JSR examples, plus API and feature matrices. Mark JSR import as not externally verified unless the scoped version is actually published; document that Deno local LevelDB is unavailable on this Windows runtime.**
- [x] **Step 5: Include only tested API signatures and actual storage, TTL, batching, scan, cache, encryption, TLS, auth, namespace, dashboard, CLI, and gRPC behavior. List remaining unsupported features plainly.**
- [x] **Step 6: Re-run README examples and final test/build/typecheck/format/lint/package checks after documentation changes.**

## Execution Choice

The user requested end-to-end implementation and replied “go” after reviewing the design. Execute this plan natively in the current session, task by task, without publishing packages or committing unrelated pre-existing changes.

