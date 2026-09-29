# SSDiskDB Verification and README Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the behavior of the current SSDiskDB implementation, fix reproducible defects in implemented functionality, and align the README with verified behavior.

**Architecture:** Use the existing Node.js `node:test` suite and real LevelDB/dashboard integration. Add source-derived feature documentation and focused tests using temporary database directories and isolated ports. Run verification before rewriting the README; make no claims about APIs absent from the public client or server implementation.

**Tech Stack:** TypeScript, Node.js, `node:test`, LevelDB (`level`), HTTP dashboard, npm scripts.

**Spec:** `docs/superpowers/specs/2026-09-29-ssdiskdb-verification-design.md`

## Global Constraints

- Preserve pre-existing modifications to `package.json`, `package-lock.json`, `.claude/`, and `src/core/`.
- Use temporary database paths and deterministic cleanup; do not touch user databases.
- Derive public features from source and actual routes; do not invent gRPC, TTL, batch, scan, or other absent public APIs.
- Test real LevelDB and HTTP behavior; do not replace integration paths with fake implementations.
- Do not report unmeasured benchmark, coverage, latency, memory, or CPU values.
- Do not add or run tests until authorized by the user’s explicit testing request in the pasted brief; the user did explicitly request testing, so execute the project’s existing tests and the necessary new verification cases.

## Review Focus

- Values serialize and deserialize as expected, including `undefined`, JSON values, strings, and binary-like inputs.
- Local and remote encryption paths have identical round-trip expectations and invalid-key behavior is predictable.
- Remote server registration and per-server namespacing prevent cross-client key access.
- Dashboard authentication, cookie sessions, role gates, and server registration behavior match their HTTP status and state effects.
- Test failures and cleanup failures do not leave LevelDB directories, servers, or intervals behind.

---

### Task 1: Establish implementation-derived feature matrix and command baseline

**Files:**
- Create: `docs/verification/feature-matrix.md`
- Inspect: `src/index.ts`, `src/dashboard.ts`, `src/cli.ts`, `src/core/*.ts`, `test.js`, `package.json`, `readme.md`, `dist/`

**Interfaces:**
- Consumes: current checked-out implementation and package scripts.
- Produces: a matrix separating public local client, HTTP remote client, CLI, dashboard, and internal-only modules.

- [ ] **Step 1: Extract public client methods and connection options from `src/index.ts`**

Record exported names and interface signatures verbatim. Distinguish methods on `SSDiskDBClient` from top-level exports and private helpers.

- [ ] **Step 2: Map remote RPC actions to server routes**

Compare `RemoteSSDiskDBClient.request()` action names against dashboard `/api/rpc` dispatch. Record which client operations are implemented remotely and any namespace translation.

- [ ] **Step 3: Inventory CLI, dashboard endpoints, and internal modules**

Extract implemented CLI command branches from `src/cli.ts`, dashboard routes from `src/dashboard.ts`, and mark `src/core` modules as internal unless imported by a public execution path.

- [ ] **Step 4: Write the matrix with evidence references**

Use columns `Category`, `Capability`, `Local`, `HTTP remote`, `CLI`, `Dashboard`, `Evidence`. Use `Not implemented` or `Internal only` where source supports that conclusion. Do not list a guessed gRPC capability.

- [ ] **Step 5: Record available package scripts and build outputs**

List only scripts present in `package.json`; identify whether benchmark/lint/typecheck/coverage commands exist. Note whether `dist` output agrees with TypeScript source before using package-level examples.

### Task 2: Run and expand real behavior tests

**Files:**
- Modify: `test.js`
- Inspect/Modify: `src/index.ts`, `src/dashboard.ts`, `src/cli.ts` only when a test exposes a defect

**Interfaces:**
- Consumes: feature matrix and existing `node:test` setup.
- Produces: assertion-based integration coverage for supported behavior, including persisted LevelDB state and HTTP responses.

- [ ] **Step 1: Review existing test lifecycle and isolation**

Inspect all `t.before`/`t.after` hooks, fixed database names, fixed ports, server close paths, and cleanup paths. Replace collision-prone resources only where necessary, retaining test intent and real integrations.

- [ ] **Step 2: Run the baseline `npm test` and `npm run build`**

Capture exit status, duration, test totals, and any failure output. The package currently defines these two scripts; do not call nonexistent lint/typecheck/benchmark scripts as though they exist.

- [ ] **Step 3: Add missing local public-operation assertions**

Exercise `set/get/del/exists/incr`, `hset/hget/hdel`, and `zset/zget/zdel` against temporary LevelDB data. Cover missing/existing values, overwrites, deletion, JSON types, empty values, and reopen persistence when supported by observed serialization semantics.

- [ ] **Step 4: Add encryption and failure behavior assertions**

Test local encryption round trips and raw stored ciphertext without printing secrets. Test wrong-key and malformed ciphertext behavior according to actual code. Add remote encrypted cases only for actions verified in remote dispatch.

- [ ] **Step 5: Add remote authentication and namespace assertions**

Run a real dashboard server against a temporary database. Check missing/invalid/valid API key handshake and two registered `serverId` clients using the same logical key; assert raw namespaced storage and cross-client isolation.

- [ ] **Step 6: Add dashboard session, role, and state assertions where gaps remain**

Use real HTTP requests and temporary storage. Verify unauthenticated access, successful/failed login, role-specific actions, and post-operation database state. Avoid duplicating existing equivalent tests.

- [ ] **Step 7: Add CLI/package smoke coverage for implemented entry points**

Exercise the built CLI help/version and non-destructive commands in child processes. For commands that mutate a database, pass a temporary `--path`; avoid tests that rely on the user's default path.

- [ ] **Step 8: Run focused tests and inspect cleanup**

Run `npm test` and `npm run build`, inspect test totals and temporary resource cleanup, and keep failure output for diagnosis.

### Task 3: Diagnose and fix verified implementation defects

**Files:**
- Modify: only source files implicated by failing assertions
- Modify: `test.js` for regression coverage

**Interfaces:**
- Consumes: reproducible failures from Task 2.
- Produces: minimal behavior fixes with regression tests, or a documented finding when behavior is an intentional/unsupported limitation.

- [ ] **Step 1: Reproduce each failure in isolation**

Run the narrowest test that demonstrates the defect and capture actual versus expected value, thrown error, or persisted state.

- [ ] **Step 2: Trace the failing operation through local or remote code**

Follow public method → serialization/key mapping → LevelDB or HTTP dispatch → state readback. Do not patch a test expectation merely to hide a mismatch.

- [ ] **Step 3: Add or retain the failing regression assertion**

The test must fail against the defective implementation and prove the externally visible behavior that needs correction.

- [ ] **Step 4: Make the smallest compatible fix**

Preserve existing method names, return values, on-disk keys, and old records unless the test proves the current behavior is broken and the fix can preserve compatibility.

- [ ] **Step 5: Rerun the focused regression and full suite/build**

Record results. If a failure cannot be safely fixed within the approved scope, document the exact limitation and do not mark it passed or skipped without evidence.

### Task 4: Rewrite README from verified code and results

**Files:**
- Modify: `readme.md`
- Reference: `docs/verification/feature-matrix.md`, `src/index.ts`, `src/dashboard.ts`, `src/cli.ts`, passing tests

**Interfaces:**
- Consumes: verified public signatures, matrix, observed behavior, and command results.
- Produces: an accurate user-facing README with runnable examples and explicit transport/security boundaries.

- [ ] **Step 1: Replace unsupported claims and architecture descriptions**

Describe local LevelDB and HTTP JSON remote mode. Remove gRPC/protobuf, native public TTL, batch, iterator scan, cache, TLS, and benchmark claims unless implementation and tests prove them. Explain that separate core modules do not imply public supported APIs.

- [ ] **Step 2: Document installation and connection forms**

Use package metadata to state the install command. Document `connect()` and `ConnectOptions`, local `storagePath`, remote URL/API key/server ID, and URI forms only after exercising them.

- [ ] **Step 3: Add verified API reference and examples**

Document actual signatures and return/absence behavior for core, hash, sorted-set, lifecycle, and credential APIs. Include examples for local CRUD, encryption, remote connection, dashboard, and CLI only where tested.

- [ ] **Step 4: Document security and data compatibility accurately**

Explain API key/server registration, dashboard login/RBAC roles, remote namespacing, and encryption limitations based on source. State storage encoding and compatibility only as verified; do not claim migration or zero breaking changes without evidence.

- [ ] **Step 5: Add troubleshooting based on observed error paths**

Include relevant connection, invalid URI/API key, decryption, and dashboard authentication errors only when tests or implementation show their messages/statuses.

- [ ] **Step 6: Add a concise API/feature support table and test report**

Link to the feature matrix. Report actual test/build totals, failures, skipped tests, and duration if available. Mark performance and coverage numbers unavailable when no benchmark/coverage tooling exists.

### Task 5: Final package verification and deliverable report

**Files:**
- Inspect: `package.json`, `package-lock.json`, `readme.md`, `docs/verification/feature-matrix.md`, `test.js`

**Interfaces:**
- Consumes: completed tests, fixes, matrix, and README.
- Produces: final reproducible validation summary and compatibility/limitation report.

- [ ] **Step 1: Run `npm test` and `npm run build` after all edits**

Capture final command output, process status, test counts, and duration.

- [ ] **Step 2: Check package installation surface without publishing**

Use `npm pack --dry-run` or an equivalent local package inspection. If a temporary consumer install is needed, install the local package into a temporary project and verify the actual CJS/ESM entry points and types supported by package metadata.

- [ ] **Step 3: Run documented examples against temporary data**

Execute each README example in a scratch script or corresponding integration test and confirm cleanup.

- [ ] **Step 4: Check final changes and user-state preservation**

Inspect `git diff` and `git status --short`; ensure pre-existing edits remain intact and no temporary database/build output is unintentionally added.

- [ ] **Step 5: Report verified outcomes and remaining issues**

State files changed, real test/build results, actual coverage/benchmark availability, supported compatibility conclusions, and absent features plainly.
