# SSDiskDB Documentation Website Design

Date: 2026-09-29

## Goal

Build a static, searchable, mobile-friendly documentation website for
`@manojgowdain/ssdiskdb` with exactly two primary documentation entry points:

- `/` for human-facing documentation.
- `/aiagents/` (available at `/aiagents`) for self-contained, structured AI
  coding-agent documentation.

The deployed site must use GitHub Pages and document only functionality present
in the current source. Update the repository README with links to the human and
AI documentation.

## Existing repository facts

- The repository is `manojgowdain/ssdiskdb`; its checked-out primary branch is
  `main`.
- A root `CNAME` contains `ssdiskdb.js.org`, and the existing Pages workflow
  triggers on `main` and currently uploads the entire repository root.
- The repository has no existing documentation-site framework. `docs/` already
  contains validation reports and project planning/spec documents, so it must
  not be used directly as the VitePress content root.
- `package.json` and `jsr.json` currently identify
  `@manojgowdain/ssdiskdb@0.1.0`. The published npm and JSR package name is
  verified. Node local storage is exercised by the package tests. The Deno
  public entrypoint smoke test passes, but local LevelDB storage has a known
  native-addon limitation on the tested Windows/Deno runtime.
- Root exports include `connect`, `parseConnectionString`, `DatabaseCore`,
  `SSDiskDBClient`, `ConnectOptions`, `SetOptions`, `MSetEntry`,
  `BatchOperation`, `ScanOptions`, and `ScanResult`; the Node package also has
  a default export containing `connect`. The JSR source entrypoint does not
  provide that default export.
- Actual client methods are String operations (`set`, `get`, `del`, `exists`,
  `incr`, `expire`, `ttl`, `persist`), bulk/scan operations (`mget`, `mset`,
  `mdelete`, `batch`, `scan`, `streamScan`), Hash field methods (`hset`,
  `hget`, `hdel`), Sorted Set member methods (`zset`, `zget`, `zdel`), and
  management/lifecycle methods (`stats`, `getAllKeys`, `flush`,
  `startDashboard`, `startGrpcServer`, credential methods, `close`).
- There are no `HEXISTS`, `HGETALL`, `HKEYS`, `HVALS`, `ZADD`, `ZRANGE`,
  `ZREVRANGE`, `ZRANK`, `ZREM`, or `ZCARD` methods in the public interface.
  Hash fields and Sorted Set members can be assigned TTL on write, but separate
  `expire`/`ttl`/`persist` methods operate on String keys.
- Remote database transport has gRPC and a legacy HTTP remote client. gRPC
  server/client, TLS, authorization, namespaces, encryption, CLI, and dashboard
  implementations exist. Dashboard HTTP is not the browser's direct LevelDB
  access path.

## Chosen approach

Use VitePress with its default theme and place the site source under
`website/`. This keeps existing `docs/` reports and specs out of the published
site, provides a static build, local search, responsive navigation, syntax
highlighting, copyable code blocks, and an emitted static 404 page without a
runtime server.

Configure the site base as `/` because the repository already has the custom
domain `ssdb.js.org` configured by `CNAME`. Put the AI agent page in a nested
index route so the static artifact contains `aiagents/index.html`, which
GitHub Pages can resolve for `/aiagents` without client-side routing. Preserve
the CNAME in the built artifact. The published site URL is
`https://ssdb.js.org/`, subject to the existing DNS and GitHub Pages settings.

Replace the workflow's repository-root upload with a build job and a deploy
job using the GitHub Pages artifact actions. Keep push-to-`main`, manual
dispatch, the existing Pages permissions, and serialized deployments. The
workflow installs from the existing lockfile and uploads only the generated
VitePress output.

## Site content

### Human entry point

The home page and sidebar will provide concise, task-oriented pages for:

- Overview, installation, quick start, runtime/package compatibility.
- Core String methods, TTL, batch operations, scans/iterators, Hash and Sorted
  Set methods, cache, statistics, and storage behavior.
- Namespaced remote clients, API-key authentication, dashboard authentication
  and RBAC, application encryption, gRPC TLS, protobuf, and connection reuse.
- CLI, dashboard, configuration, architecture, migration, errors, examples,
  and troubleshooting.

Pages will omit APIs absent from the code and explain current limitations where
they affect callers. Examples will use placeholders for credentials and keys.
Performance claims will refer to committed benchmark methodology/results and
will not claim improvements unsupported by those measurements.

### AI agent entry point

`/aiagents` will be a distinct, self-contained reference for code-generation
agents. It will state package identity and version, install/import rules,
runtime caveats, actual signatures and behaviors, examples, error handling,
common mistakes, compatibility rules, and API-selection decision rules. It
will clearly distinguish supported methods from similarly named Redis APIs
that SSDiskDB does not implement.

The site will publish `/aiagents.json` as a machine-readable contract. A
repository script will derive the package name/version and client method/export
names from `package.json`, `jsr.json`, and the TypeScript public declarations;
checked-in explanatory fields will be limited to behavior not mechanically
represented by TypeScript. Validation will compare generated contract content
with source and ensure it is current. The human page, agent page, and JSON
contract will be generated from the same checked-out version.

## Documentation examples and validation

Executable examples will live under a dedicated website examples/test
directory and be exercised against the built local API with temporary LevelDB
directories. Cover local quick start, CRUD and TTL, batching, Hash, Sorted Set,
and scan APIs. Examples for cache, gRPC, TLS, encryption, and namespace
configuration will be checked against actual options and existing integration
coverage; tests requiring external certificates or services will use local
fixtures and ephemeral ports where feasible. Deno examples will be limited to
capabilities validated by the current Deno runtime; the site must disclose the
known native LevelDB limitation instead of implying cross-runtime storage
parity.

Add a link/route validation script that verifies the built root, nested
`aiagents/index.html`, `404.html`, and JSON asset, and checks local Markdown
links against generated pages/assets. Run the actual VitePress production build
and the example checks before completion.

## README and navigation

Add a Documentation link and an AI Agent Documentation link to the repository
README using `https://ssdb.js.org/` and `https://ssdb.js.org/aiagents`. Include
the AI link in the site's top navigation and footer. The VitePress navigation
and sidebar will cover all implemented feature groups without adding a third
primary documentation entry point.

## Deployment and operations

Add a `docs:dev` and `docs:build` script and a minimal VitePress development
dependency. Add the VitePress source/configuration, human documentation pages,
AI-agent page, static 404 page, contract generator, validation script, and
example tests. Update the existing `.github/workflows/deploy-pages.yml` rather
than creating a competing Pages deployment. Do not commit generated output.

The workflow deploys on `main` pushes and manual dispatch with
`actions/configure-pages`, `actions/upload-pages-artifact`, and
`actions/deploy-pages`; it keeps `contents: read`, `pages: write`, and
`id-token: write` permissions and uses a single non-canceling Pages concurrency
group.

## Security and trust boundaries

Documentation must never include real credentials or encryption secrets.
Examples use `YOUR_API_KEY`, `YOUR_SECRET`, and certificate placeholders. It
will explain that local applications own LevelDB, remote clients communicate
with the database server over gRPC or the legacy HTTP transport, authorization
must be validated before remote operations, namespaces are selected by
authorized server identity, client-side encryption is separate from TLS, and
the dashboard talks through its server-side layer. It will not suggest that
TLS is enabled by default: gRPC is insecure unless TLS options are configured.

## Out of scope

- Changing database behavior, public APIs, storage, auth, or package versions.
- Publishing a new npm or JSR version.
- Replacing the database README with the website or publishing planning and
  validation artifacts as site pages.
- Claiming support for APIs or runtimes not represented by source and tests.
- Changing the configured custom domain or repository Pages settings.

## Acceptance criteria

1. VitePress builds a static site whose output contains `index.html`,
   `aiagents/index.html`, `404.html`, assets, `aiagents.json`, and the custom
   domain CNAME.
2. `/` and `/aiagents` resolve as static pages; the agent page has a direct
   navigation link from the human site.
3. Search, syntax-highlighted/copyable code, mobile navigation, metadata, and
   the static 404 are available in the generated site.
4. All documented API methods/exports correspond to actual public declarations;
   unsupported Redis-like methods are explicitly excluded.
5. The machine-readable contract is generated from package metadata and source
   declarations and passes a drift check.
6. Local examples for supported Node APIs pass, the Deno storage limitation is
   explicit, and all internal documentation links resolve.
7. The README links to both documentation entry points.
8. The Pages workflow runs on pushes to `main` and manual dispatch, uploads
   only the static site artifact, and uses current Pages deployment actions.
9. Existing package tests/build and documentation validation pass; no generated
   site output is committed.
