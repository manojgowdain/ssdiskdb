# SSDiskDB Documentation Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and automatically deploy a static VitePress documentation site for SSDiskDB with a human home at `/`, a self-contained AI coding-agent reference at `/aiagents`, and a source-verified `/aiagents.json` contract.

**Architecture:** Keep website source in `website/` so existing `docs/` reports/specs do not become public pages. VitePress generates static routes/assets; a TypeScript-AST script generates the machine-readable API contract from package metadata and the public declarations; tests execute local examples and verify routes/links; GitHub Actions builds and deploys only VitePress output while preserving the existing custom domain.

**Tech Stack:** Existing Node.js/TypeScript package; VitePress default theme; Node built-in test runner; TypeScript compiler API for contract generation; GitHub Pages artifact workflow.

**Spec:** `docs/superpowers/specs/2026-09-29-ssdiskdb-docs-site-design.md`

## Global Constraints

- The site has exactly two primary documentation entry points: `/` and `/aiagents`.
- The repository's existing CNAME is `ssdiskdb.js.org`; configure the static site base as `/` and preserve the CNAME in the output.
- Document only actual public exports and implemented APIs; unsupported Redis-like APIs must not be presented as available.
- Keep website sources under `website/`; do not publish existing planning or validation files from `docs/`.
- Keep the site static and deploy the generated site artifact, never the repository root.
- Do not change database behavior, package version, or publish npm/JSR packages.
- Do not put real API keys, passwords, encryption keys, or private keys in source or examples.
- Node local storage is the fully exercised runtime; describe Deno as source/entrypoint checked with a known Windows native LevelDB limitation.
- GitHub Actions deployment triggers on `main` and manual dispatch, uses Pages artifact deployment, and preserves serialized non-canceling deployments.
- Do not claim performance gains unsupported by the repository's measurements.

## Review Focus

1. **Pretty route under a custom-domain root:** `/aiagents` must resolve directly to nested static HTML without depending on client-side fallback; test for `website/.vitepress/dist/aiagents/index.html`, root-relative assets, and `/aiagents` navigation.
2. **Metadata drift:** npm and JSR versions or names may diverge; contract generation must reject mismatched package identities/versions and tests must verify the package and JSR metadata match.
3. **Public API drift or Redis-name confusion:** code declarations may change or unsupported method names may creep into agent docs; compare JSON method/export names against the source AST and require explicit unsupported-method wording in `/aiagents`.
4. **TTL and data-structure scope:** `expire`/`ttl`/`persist` apply to String keys while Hash fields and Sorted Set members accept TTL only when written; test/docs checks must pin this scope and avoid implying Hash/ZSet range APIs.
5. **Runtime/security overstatement:** JSR/Deno imports, local LevelDB support, legacy HTTP, gRPC TLS, and application encryption have different limits; inspect examples and generated content so no claim implies Deno native storage parity or TLS by default.

---

### Task 1: VitePress site shell and route output

**Files:**
- Create: `website/.vitepress/config.ts`
- Create: `website/index.md`
- Create: `website/aiagents/index.md` (initial minimal page; replaced with full content in Task 4)
- Create: `website/guide/quick-start.md` (initial route target; full content in Task 3)
- Create: `website/404.md`
- Create: `website/public/CNAME` (copied from the verified repository CNAME)
- Modify: `package.json` (add VitePress dev dependency and `docs:dev`, `docs:build` scripts)
- Modify: `package-lock.json`
- Test: `tests/docs-output.test.js`

**Interfaces:**
- Produces `npm run docs:build`, which builds `website/` to `website/.vitepress/dist/`.
- Produces VitePress base `/`, routes `/` and `/aiagents`, local full-text search, primary navigation, responsive default-theme layout, syntax highlighting, code-copy controls, metadata, and a static 404 route.
- Later tasks consume the `website/` source root, site config/nav and `website/.vitepress/dist/` output location.

- [ ] **Step 1: Write route-output assertions first**

Add `tests/docs-output.test.js` using `node:test`, `node:assert/strict`, and
`node:fs`. Assert that the configured output path contains `index.html`,
`aiagents/index.html`, `404.html`, and `CNAME`, and that HTML has links to
`/aiagents` and contains the page title. Also assert the site config declares
`base: '/'`. Before the site is built these assertions must fail because the
output files do not exist.

- [ ] **Step 2: Run the new test and confirm it fails for missing output**

Run: `node --test tests/docs-output.test.js`
Expected: FAIL because the VitePress output has not been generated yet.

- [ ] **Step 3: Install and configure VitePress**

Run: `npm install --save-dev vitepress`

Add scripts:

```json
{
  "docs:dev": "vitepress dev website",
  "docs:build": "vitepress build website"
}
```

Configure title/description, `base: '/'`, local search, TypeScript/JavaScript/
JSON/YAML/Bash/protobuf syntax highlighting, primary nav links, footer AI-doc
link, canonical `https://ssdb.js.org/`, robots and Open Graph tags. Add the
home hero with links to `/guide/quick-start` and `/aiagents`. Keep initial nav
links limited to routes created in this task; Task 3 adds the full sidebar
after the guide pages exist. Add the nested
AI route page, a useful 404 page linking home/search/AI docs, and copy the
repository CNAME to `website/public/CNAME` so VitePress includes it in output.

- [ ] **Step 4: Build and run the route assertions**

Run: `npm run docs:build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node --test tests/docs-output.test.js`
Expected: VitePress builds successfully; root, AI, 404, and CNAME assertions
pass. The AI page may be minimal until Task 4, but it must resolve statically.

- [ ] **Step 5: Commit the site shell**

```bash
git add package.json package-lock.json website tests/docs-output.test.js
git commit -m "docs: scaffold static VitePress site"
```

### Task 2: Generate the machine-readable API contract

**Files:**
- Create: `scripts/generate-aiagents-contract.mjs`
- Create: `website/public/aiagents.json` (generated source asset, committed and checked for drift)
- Create: `tests/docs-contract.test.js`
- Modify: `package.json` (run generator before VitePress build)
- Modify: `package-lock.json` only if a direct dependency is required; prefer existing TypeScript compiler dependency

**Interfaces:**
- Consumes `package.json`, `jsr.json`, and `src/index.ts`.
- Produces `node scripts/generate-aiagents-contract.mjs` (write mode) and `--check` (drift-check mode).
- JSON top-level contract contains `package`, `version`, `license`, `entrypoints`, `exports`, `clientMethods`, `runtimeNotes`, and `unsupportedMethods`. Keep Node's default `{ connect }` export distinct from JSR's named-only exports.
- Each client method is represented by its source declaration signature text. Exports and methods are extracted from TypeScript AST, not copied into the generator's output list.
- Task 4 links to `/aiagents.json`; Task 6 runs `--check` and confirms generated output is current.

- [ ] **Step 1: Write source-contract tests**

Add tests that execute the generator in `--check` mode and parse the JSON.
Assert package name/version/license match both manifests, named exports include
the actual root symbols and the Node entrypoint default export is `{ connect }`,
and client methods include each method from
`SSDiskDBClient`. Assert `hgetall`, `hexists`, `zrange`, `zrank`, and `zcard` do
not appear in `clientMethods`, while `unsupportedMethods` records these as
unsupported. Assert `runtimeNotes` clearly says Node local LevelDB is exercised
and Deno local LevelDB has the known native-addon limitation. Tests initially
fail because the contract/generator do not exist.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `node --test tests/docs-contract.test.js`
Expected: FAIL because the generator and JSON contract do not exist.

- [ ] **Step 3: Implement AST-backed generation**

Use `typescript` already present in `devDependencies`. Parse `src/index.ts`,
collect exported declarations and type/interface members from
`SSDiskDBClient`, and serialize the exact declarations using
`node.getText(sourceFile)`. Read package metadata; fail with a clear diagnostic
if `package.json` and `jsr.json` package name, version, or license differ.
Write deterministic, two-space-indented JSON with a final newline. `--check`
must generate in memory and compare byte-for-byte with
`website/public/aiagents.json`, exiting non-zero with a regeneration command
when stale. Keep only verified explanatory facts (including current Deno
limitations) as curated fields.

- [ ] **Step 4: Wire generation and run contract tests**

Change `docs:build` to run the generator before `vitepress build website`.
Run: `node scripts/generate-aiagents-contract.mjs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node --test tests/docs-contract.test.js`
Expected: deterministic JSON is produced and all AST/metadata/drift assertions
pass.

- [ ] **Step 5: Commit the contract generator**

```bash
git add scripts/generate-aiagents-contract.mjs website/public/aiagents.json tests/docs-contract.test.js package.json
git commit -m "docs: generate agent API contract from source"
```

### Task 3: Human-facing documentation pages

**Files:**
- Create: `website/guide/installation.md`
- Create: `website/guide/quick-start.md`
- Create: `website/guide/architecture.md`
- Create: `website/api/core.md`
- Create: `website/api/ttl-batch-scan.md`
- Create: `website/api/hash-sorted-set.md`
- Create: `website/security/remote-access.md`
- Create: `website/tools/cli-dashboard.md`
- Create: `website/guide/compatibility.md`
- Modify: `website/index.md`
- Modify: `website/.vitepress/config.ts`
- Test: `tests/docs-content.test.js`

**Interfaces:**
- Consumes the site shell and navigation from Task 1.
- Produces actual-source-based human pages and sidebar links. Task 5's link validator checks all generated links.
- Public API names/signatures must agree with `SSDiskDBClient` and the root exports from `src/index.ts`.

- [ ] **Step 1: Write content accuracy tests**

Create a test that reads the markdown sources and verifies the supported API
method list appears, package installation/imports use
`@manojgowdain/ssdiskdb`, TTL units/return values are stated, Hash and Sorted
Set scope is accurate, and unsupported range/aggregate method names are not
presented as implemented. Include checks that the architecture mentions local
LevelDB ownership, gRPC, and the separate dashboard layer. Confirm test fails
before the pages exist.

- [ ] **Step 2: Run the content test and confirm failure**

Run: `node --test tests/docs-content.test.js`
Expected: FAIL because content pages and/or API text have not been added.

- [ ] **Step 3: Write source-verified page content and examples**

Use only real signatures and behavior. Installation covers npm, local Deno
entrypoint, and published JSR availability, with the native storage caveat.
Quick start runs `connect()`, `set`, `get`, `close`. Core/API covers every
public client method; TTL explains millisecond values, `-2`/`-1`, expiration,
and String-only `expire`/`ttl`/`persist`. Batch/scan explains return shapes,
limits/cursors, and why `getAllKeys()` materializes. Hash/ZSet explain only
field/member methods and write-time TTL. Security/remote pages explain API key,
registered server ID, namespaces, legacy HTTP vs primary gRPC, protobuf,
connection reuse, TLS options, app encryption, and dashboard trust boundary.
CLI page derives command/options from `src/cli.ts`. Compatibility/migration
distinguishes old `ssdiskdb` from scoped package and Node default export from
JSR named exports. Include no undocumented `HEXISTS`, `HGETALL`, score range,
rank, or cardinality methods.

- [ ] **Step 4: Build and run content tests**

Run: `node --test tests/docs-content.test.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run docs:build`
Expected: content accuracy checks pass and VitePress builds all linked pages.

- [ ] **Step 5: Commit human docs**

```bash
git add website
git add tests/docs-content.test.js
git commit -m "docs: add SSDiskDB developer guides"
```

### Task 4: Self-contained AI-agent reference

**Files:**
- Modify: `website/aiagents/index.md`
- Modify: `website/.vitepress/config.ts`
- Test: `tests/docs-agent.test.js`

**Interfaces:**
- Consumes generated `/aiagents.json` from Task 2 and actual source exports.
- Produces the self-contained `/aiagents` reference and AI-agent nav/footer links; Task 5 validates its links and examples.

- [ ] **Step 1: Write deterministic agent-document tests**

Assert the page says it is optimized for AI coding agents; contains sections
for package identity, runtime/import rules, public API, TTL, batch, Hash,
Sorted Set, scans, cache, namespaces/auth, RBAC, encryption, gRPC, CLI,
configuration, errors, TypeScript, Deno/JSR, compatibility, examples, common
mistakes, and decision rules; links `/aiagents.json`; includes each generated
client method/signature; and excludes unsupported method names from supported
API code fences. Require anti-pattern text discouraging invented Redis methods,
direct LevelDB access, bypassing auth/namespaces, per-request gRPC channels,
and application `setTimeout` TTL. These tests fail against the initial minimal
page.

- [ ] **Step 2: Run agent-doc tests and confirm failure**

Run: `node --test tests/docs-agent.test.js`
Expected: FAIL because the initial AI page is only a route placeholder.

- [ ] **Step 3: Write the structured agent page**

Use concise `Purpose`, `Signature`, `Parameters`, `Returns`, `Example`,
`Errors`, `TTL`, `Concurrency`, `Remote/gRPC support`, and `Notes` blocks for
every actual client method. Keep it
self-contained: include install/import examples, supported Node/JSR/Deno
details, exact method names and return behavior, working local and gRPC
connection forms, placeholder secrets, TLS/encryption distinction, namespace
rules, common mistakes, and explicit selection rules. Link the complete
machine-readable contract and human guides for more explanation. The generated
contract is the source of exact signatures; tests enforce its inclusion.

- [ ] **Step 4: Run agent tests and build**

Run: `node --test tests/docs-agent.test.js; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run docs:build`
Expected: all agent contract assertions pass and VitePress renders the agent
route.

- [ ] **Step 5: Commit AI-agent reference**

```bash
git add website/aiagents/index.md website/.vitepress/config.ts tests/docs-agent.test.js
git commit -m "docs: add AI agent API reference"
```

### Task 5: Executable examples and static output/link validation

**Files:**
- Create: `website/examples/quick-start.mjs`
- Create: `website/examples/ttl-batch-structures.mjs`
- Create: `website/examples/cache-encryption.mjs`
- Create: `website/examples/grpc-client.mjs`
- Create: `website/examples/tls-client.mjs`
- Create: `website/examples/deno-entrypoint.ts`
- Create: `website/examples/jsr-entrypoint.ts`
- Create: `tests/docs-examples.test.js`
- Create: `tests/docs-links.test.js`
- Create: `scripts/verify-docs-output.mjs`
- Test: `tests/docs-output.test.js` (extend the Task 1 route assertions)
- Modify: `package.json` (add `docs:test` and final build verification)
- Modify: `package-lock.json` only if selecting a direct YAML parser for workflow tests

**Interfaces:**
- Node examples export `runExample(connect, storagePath, options?)` so tests use the same source snippets with isolated temporary databases; VitePress includes runnable code from these files instead of maintaining duplicate blocks.
- `scripts/verify-docs-output.mjs` reads `website/.vitepress/dist`, validates required artifacts, checks internal links against generated routes/assets, and verifies generated `/aiagents.json` matches the source contract.
- Task 6 invokes `npm run docs:test` and `npm run docs:build` in CI.

- [ ] **Step 1: Write failing example and output tests**

Use `node:test` with temporary directories from `node:fs`, `node:os`, and
`node:path`. Execute examples against `require('../dist/cjs/index.js').connect`
after `npm run build`. Assert quick-start set/get; TTL read, expire, persist;
batch count and results; Hash field and Sorted Set score operations; and prefix
scan results; bounded cache behavior; local encrypted roundtrip; and
authenticated gRPC/TLS client roundtrips in temporary local servers and
namespaces. Generate test-only TLS certificates in a temporary directory
using the OpenSSL fixture approach already present in `test-upgrade.js`.
Register
the temporary server identity in the fixture database, start on an ephemeral
port, and inject the address/key/identity into the exact `grpc-client.mjs`
example. Check the Deno entrypoint sample with `deno check`. Check the JSR
import sample against the published registry with `deno check` during final
validation, not as a requirement for offline local docs builds. Create a
link-test that runs `scripts/verify-docs-output.mjs` with `spawnSync` and fails
if it exits non-zero. Extend output assertions to verify `404.html`,
`aiagents/index.html`, `aiagents.json`, root `index.html`, and CNAME. The
example/link tests fail before their modules/scripts exist.

- [ ] **Step 2: Run new tests and confirm failure**

Run: `node --test tests/docs-examples.test.js tests/docs-links.test.js`
Expected: FAIL because the example modules and output verifier are missing.

- [ ] **Step 3: Add executable examples and route verifier**

Make each Node example accept injected `connect` and a storage path, and close
all clients/server handles in `finally`. Use a fresh temp path per test and
remove it after close. The quick-start example is identical in operations and
imports to the page. The structures example exercises TTL/batch/Hash/Sorted
Set/scan calls; the cache/encryption example tests actual `ConnectOptions`;
the gRPC/TLS examples use injected authenticated servers. Include the runnable
source snippets in VitePress pages so tests execute the same code. Check the
Deno sample locally and the JSR import with
`deno check jsr:@manojgowdain/ssdiskdb`; document the known Windows/Deno native
LevelDB limitation. `verify-docs-output.mjs` maps a route `/foo/` to
`foo/index.html` and `/foo` to either `foo.html` or `foo/index.html`; reject
missing local links, missing requested assets, and absent CNAME/JSON/404.
Do not fetch the live site or follow external links in this script.

- [ ] **Step 4: Run full documentation checks**

Set `docs:test` to run `npm run build` followed by
`node --test tests/docs-output.test.js tests/docs-links.test.js tests/docs-contract.test.js tests/docs-content.test.js tests/docs-agent.test.js tests/docs-examples.test.js`.
Make `docs:build` run the contract generator, VitePress build, and
`scripts/verify-docs-output.mjs`. Run:

```powershell
npm run build
npm run docs:test
npm run docs:build
```

Expected: Node examples and the Deno entrypoint check pass, all internal links
resolve, and static root, AI route, JSON contract, 404, and CNAME exist. The
JSR example is verified separately during final validation. No VitePress dist
directory is tracked by git.

- [ ] **Step 5: Commit examples and validation**

```bash
git add website/examples tests/docs-examples.test.js tests/docs-links.test.js tests/docs-output.test.js scripts/verify-docs-output.mjs package.json package-lock.json
git commit -m "test: validate documentation examples and routes"
```

### Task 6: README links and GitHub Pages deployment

**Files:**
- Modify: `readme.md`
- Modify: `.github/workflows/deploy-pages.yml`
- Create: `tests/docs-workflow.test.js`
- Modify: `package.json` and `package-lock.json` (add the small `yaml` dev dependency used to parse the workflow in tests)

**Interfaces:**
- Consumes `npm run docs:build` and generated output from Tasks 1-5.
- Produces README human/agent documentation links and a two-job Pages artifact workflow which builds on push to `main` and `workflow_dispatch`.

- [ ] **Step 1: Write workflow/README assertions**

Run: `npm install --save-dev yaml`

Create a workflow test using the `yaml` parser to assert workflow name, push
branch `main`, manual dispatch, `contents: read`, Pages write/id-token
permissions, deploy-job `actions: read`, one serialized `pages` concurrency
group with `cancel-in-progress: false`, Node setup and `npm ci`,
`npm run docs:build`, upload of `website/.vitepress/dist`, build-to-deploy job
dependency, and use of the official Pages configure/upload/deploy actions.
Assert the README has both
`https://ssdb.js.org/` and `https://ssdb.js.org/aiagents` links. The test fails
because the current workflow uploads the entire repository and README links
are not present.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test tests/docs-workflow.test.js`
Expected: FAIL because the current workflow does not build/upload the
VitePress artifact and the README has no documentation section. Then append
`tests/docs-workflow.test.js` to the explicit file list in `docs:test`.

- [ ] **Step 3: Update README and Pages workflow**

Add a concise Documentation section with the human and AI URLs. Replace the
single-job root upload with a build job that checks out the repository, sets up
Node 22, runs `npm ci`, builds and verifies docs, and uploads
`website/.vitepress/dist`. Add a deploy job with `needs: build`, a
`github-pages` environment and URL output, and `actions/deploy-pages`. Use the
currently verified official action versions: `actions/checkout@v7`,
`actions/setup-node@v7`, `actions/configure-pages@v6`,
`actions/upload-pages-artifact@v5`, and `actions/deploy-pages@v5`. Grant
`actions: read` only to the deploy job; keep `contents: read` on the workflow
and `pages: write`/
`id-token: write` on deployment. Retain non-canceling concurrency.
Keep `CNAME` in the artifact by verifying it is copied from
`website/public/CNAME`; never upload the repository root.

- [ ] **Step 4: Validate workflow, README, and rendered site**

Run:

```powershell
node --test tests/docs-workflow.test.js
npm test
npm run typecheck
npm run build
npm run docs:test
npm run docs:build
deno check website/examples/deno-entrypoint.ts
deno check website/examples/jsr-entrypoint.ts
deno check jsr:@manojgowdain/ssdiskdb
git diff --check
```

Expected: the workflow parses and matches its contract, existing tests/type
checks/build pass, all docs examples and output/link checks pass, and the
generated artifact contains only website files and the custom-domain CNAME.
Use a local static server against the VitePress output and inspect `/`,
`/aiagents`, `/404.html`, search, code-copy, and responsive desktop/mobile
navigation in a browser. The static site must work with direct URL entry and
without a Node runtime server-side route.

- [ ] **Step 5: Commit deployment and README links**

```bash
git add readme.md .github/workflows/deploy-pages.yml tests/docs-workflow.test.js package.json package-lock.json
git commit -m "ci: deploy SSDiskDB documentation to GitHub Pages"
```

## Completion checks

After all tasks, verify the complete spec acceptance list: static `/` and
`/aiagents` routes; `/aiagents.json`; search/navigation/404; API/source parity;
tested Node examples; explicit Deno limits; zero unresolved local links; README
links; workflow triggers and least-privilege Pages deployment; existing npm
test/typecheck/build. Inspect `git status` to ensure no generated VitePress
output is committed. Do not publish to npm/JSR or push/merge as part of this
plan.
