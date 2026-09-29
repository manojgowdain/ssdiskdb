# Scoped Package, Deno, and JSR Distribution Design

## Goal and constraints

Make `@manojgowdain/ssdiskdb` the package identity for the repository and provide verified Node/npm, Deno, and JSR entry points without replacing the LevelDB database, changing SSDiskDB's public database behavior, weakening security, publishing externally, or claiming registry availability that has not been verified.

The scoped package starts at version `0.1.0`, as specified in the supplied request. Its license metadata remains `Apache-2.0`, matching the repository's actual `LICENSE` file. The existing published `ssdiskdb` package is left untouched; current registry lookup shows version `1.1.0` and no deprecation marker, while the scoped name currently returns 404.

## Current-state findings

- Local `package.json` and lockfile identify `ssdiskdb@1.0.2`; npm currently serves the unscoped name at `1.1.0`.
- `deno.json` and `jsr.json` declare `@manojgowdain/ssdiskdb@0.1.0` with MIT, conflicting with the root Apache-2.0 license.
- `mod.ts` is empty. Consequently `deno check mod.ts` and JSR dry-run success are not meaningful API checks; JSR dry-run currently includes unrelated development files.
- `deno check src/index.ts` fails immediately because `src/index.ts` imports `crypto` instead of `node:crypto`.
- The actual public entry point exports `connect`, `parseConnectionString`, `DatabaseCore`, `LocalSSDBClient`, public interfaces/types, and a default object containing `connect`. Local API implementations remain in the shared core.
- npm currently exposes `main` as CommonJS, `module` as ESM, and `types`, but lacks a conditional `exports` map. Direct Node ESM loading has previously failed due to extensionless generated imports.
- Node-level dependencies include `level`, `@grpc/grpc-js`, and `@grpc/proto-loader`; the protobuf file is a required runtime asset.

## Distribution design

Keep one database implementation and one source of truth. Build the existing TypeScript sources into CommonJS and ESM Node outputs, and expose the public API through a real `mod.ts` for Deno/JSR. Use explicit source import extensions and TypeScript's relative-import rewrite behavior where it preserves emitted Node paths. Use Deno npm dependency mappings only for runtime dependencies actually required by the public entry point. Do not create a second Deno database backend or export internal modules as a workaround.

The npm manifest will use conditional exports for `types`, `import`, and `require`, include built outputs and the protobuf asset, and preserve the `ssdiskdb` CLI executable name. Public package imports and project examples change to `@manojgowdain/ssdiskdb`; storage prefixes, protocol service/package names, internal identifiers, dashboard labels, and the CLI command remain `ssdiskdb` where those strings are part of established behavior.

The Deno/JSR manifests will share package name, version, license, repository metadata where supported, and a single public export. JSR publish filters will exclude databases, tests, local settings, build outputs, and unrelated deployment assets while including the entry point, runtime source, README, LICENSE, and required protobuf asset if it is part of the public runtime. No registry publication is part of this work.

## Validation design

1. Confirm the public surface against the TypeScript entry point and write a feature matrix with Local, gRPC, CLI, Dashboard, npm, Deno/JSR, and tested columns.
2. Add Deno tests for the public entry point and local temporary LevelDB behavior; run `deno check`, `deno test`, `deno fmt --check`, `deno lint`, and `deno publish --dry-run` where applicable.
3. Build the npm package, create a tarball, install it into a temporary consumer, and execute ESM named imports plus database SET/GET/DELETE/TTL. Verify CJS only if the exports continue to promise it; exercise package CLI and type resolution.
4. Keep the existing Node regression suite intact; add package/runtime tests rather than changing expected behavior to force compatibility.
5. Run the existing benchmark scripts, capture only measured values, and report that JSR scoped registry installation cannot be verified until a version is published.
6. Rewrite the README after validation with actual runtime and feature support, a truthful old-to-new npm migration note, and no false publication/deprecation statement.

## Failure policy and boundaries

If the existing LevelDB or gRPC dependency stack cannot be supported under Deno after a reasonable single-source compatibility pass, do not substitute a different storage engine or pretend the package works. Isolate the compatibility boundary, test the exact failing operation, and update the compatibility matrix and README to mark that runtime unsupported pending a separate storage/network design. Do not publish to npm or JSR, change production databases, alter API keys, or replace the source license.

## Design self-review

- **Coverage:** package rename, public API, Node ESM/CJS, Deno and JSR manifests, npm tarball consumer, tests, feature matrix, benchmarks, README, and limitations are addressed.
- **Consistency:** scoped package version is `0.1.0` across npm, Deno, and JSR; Apache-2.0 matches `LICENSE`; old package remains unmodified in the registry.
- **Compatibility:** storage key names, protocol names, existing local API, CLI executable, and LevelDB data remain unchanged.
- **Open technical risk:** Deno compatibility of LevelDB and gRPC npm dependencies must be established by real runtime checks; source compatibility alone does not establish runtime support.
