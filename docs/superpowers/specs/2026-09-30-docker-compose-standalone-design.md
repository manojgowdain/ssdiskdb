---
name: docker-compose-standalone
description: Spec for adding Docker/Compose + official standalone install to SSDiskDB
type: project
---

# SSDiskDB — Docker / Compose + Official Standalone Installation Design

Date: 2026-09-30
Status: approved (verbal "go" from user on 2026-09-30)

## Goal
Make SSDiskDB a production-ready standalone local database/cache server installable two ways:

1. Native standalone: `curl -fsSL https://ssdiskdb.js.org/install.sh | bash`
2. Docker / Docker Compose: build locally from source (NO Docker Hub for SSDiskDB).

## Context found (audit)
- Package: `@manojgowdain/ssdiskdb@0.2.0` (scoped), published on npm. `bin` → `dist/cjs/cli.js`. Ships `dist/` + `proto/`.
- `npm pack` consumer test (`scripts/test-npm-pack.cjs`) already passes.
- `src/cli.ts:91` `--path` defaults to `./ssdb-local-db`; `src/cli.ts:92` port default `8971`.
- `src/index.ts:1038-1041` opens LevelDB at `storagePath`; `setCredentials`/`getCredentials` store/read `config:username`+`config:password`.
- BUG (confirmed): `src/cli.ts:208` prints hardcoded `Default credentials: manoj / manoj (Use credentials command to change)` regardless of stored credentials, and prints the password. Startup message must read from `getCredentials()` and never print the password.
- `src/dashboard.ts:21` `http.createServer` then `server.listen(port)` — on Linux defaults to `::`/`0.0.0.0` (Docker-safe already), but must be explicit + cross-platform via `server.listen(port, host)`.
- No `/health` endpoint exists — must add a minimal one.
- `install.sh` exists but (a) installs legacy unscoped `ssdiskdb` not `@manojgowdain/ssdiskdb`; (b) documents `raw.githubusercontent.com/.../install.sh`; (c) references a non-existent `ssdiskdb server add <id>` command; (d) Linux/macOS only.
- Existing `Dockerfile`: builds from source via TS build inside container, `CMD ... start --port 8971 --path /data`. Per requirements it must instead `npm install @manojgowdain/ssdiskdb` and be env-driven.
- `index.html` (GitHub Pages site, `CNAME=ssdiskdb.js.org`, deployed via `upload-pages-artifact` with `path: '.'`): links Docker Hub image, documents `raw.githubusercontent.com/.../install.sh`.
- GitHub Actions: only `deploy-pages.yml`. No CI install/docker tests.
- Docker available locally (v29.5, Compose v5.1). Node 20/npm 18 available.

## Design Decisions
1. Env vars: `SSDISKDB_DATA_DIR` (storage path), `SSDISKDB_PORT` (dashboard, default 8971), `SSDISKDB_USERNAME`/`SSDISKDB_PASSWORD` (seed admin creds only-if-unset), `SSDISKDB_HOST` (bind host, default `0.0.0.0`). CLI flags always override env. Native install keeps `./ssdb-local-db`; Docker overrides to `/data/ssdb-local-db`.
2. Dockerfile: `node:lts-alpine` base (allowed — only SSDiskDB itself must not come from Docker Hub). `npm install -g @manojgowdain/ssdiskdb`, create `/data/ssdb-local-db`, `EXPOSE 8971`, `HEALTHCHECK` → `CMD wget -q --spider http://127.0.0.1:8971/health || exit 1` (alpine has wget; avoids node -e startup cost). `CMD ["ssdiskdb","start","--path","/data/ssdb-local-db"]`.
3. `docker-compose.yml` (compose v2): `build: { context: . }`, `ports: ["8971:8971"]`, `volumes: ["./ssdb-local-db:/data/ssdb-local-db"]`, `restart: unless-stopped`, `environment: { SSDISKDB_DATA_DIR: /data/ssdb-local-db }`.
4. `docker-install.sh`: idempotent — if repo already cloned & compose already running, skips build; clones fresh otherwise; `docker compose up -d --build`; verifies `ssdiskdb.js.org`/port; prints dashboard URL. Safe to re-run.
5. `install.sh` rewrite: `set -euo pipefail`; detect OS; require/ install Node≥18; `npm install -g @manojgowdain/ssdiskdb`; verify `ssdiskdb --version`; on Windows (no `apt`/`brew`) fall back to `npm install -g` if Node exists, else instruct manual; print version + `ssdiskdb start` + `http://localhost:8971`. No `sudo` unless writing to a system global dir that requires it.
6. Health endpoint in `dashboard.ts`: `GET /health` → `200 {"status":"ok"}` (no auth).
7. Fix startup message in `cli.ts`: after `connect()` succeeds for a local `start`, call `getCredentials()` and print `Credentials configured: <username>` (or `Default credentials detected — run "ssdiskdb credentials" to change` only when password hash still equals the default `manoj` hash). Never print password.
8. Host binding: `startDashboardServer` signature gains an optional `host` param default `0.0.0.0`; `cli.ts` passes `process.env.SSDISKDB_HOST || "0.0.0.0"`.

## Files To Add
- `docker-compose.yml`
- `docker-install.sh` (executable)
- `tests/docker-persistence.test.cjs` (integration: build, up, write, restart, read, down)
- `docs/installation.md`
- `docs/credentials.md`
- `docs/docker.md`
- `MEMORY.md` entry (if needed)

## Files To Modify
- `src/cli.ts` — env-var config, host binding, fix startup credential message, `--version`/`--help` already work.
- `src/index.ts` — env defaults for storagePath & dashboardPort at `connect()` time (so library consumers also benefit); pass host into `startDashboardServer`.
- `src/dashboard.ts` — add `/health`; accept `host` param.
- `Dockerfile` — rewrite per decision 2.
- `install.sh` — rewrite per decision 5.
- `index.html` — remove Docker Hub badge + raw install URL; add Docker Compose + env-var docs + one-line docker install; update installation section.
- `readme.md` — complete rewrite per task section 34.
- `sitemap.xml` — add `/install.sh`, `/docker-install.sh`.
- `.github/workflows/ci.yml` (new) — npm tests + docker persistence test.
- `.github/workflows/deploy-pages.yml` — already uploads `.`; no change needed (installers at root become served).
- `.gitignore` — ensure `ssdb-local-db/` (already ignored) and no docker-data committed.
- `scripts/test-npm-pack.cjs` — no change expected (still passes).

## Verification Plan
- `npm test`
- `npm run test:package`
- `npx ssdiskdb --version` ; `npx ssdiskdb --help`
- Native `ssdiskdb start` + credentials round-trip (password not printed)
- `docker compose build --no-cache && up -d` → dashboard at :8971 → `/health` 200
- Write key via API, `docker compose restart`, read key back → equal
- `docker compose down && docker compose up -d`, read key back → equal
- `docker compose down` cleanup
- `https://ssdiskdb.js.org/install.sh` reachable (after Pages build completes post-push)

## Open Questions (resolved by verbal approval)
- node:lts-alpine base: approved.
- /health endpoint: approved.
- docker-install.sh path: repo root.
- Windows fallback in install.sh: OS-detection branch.
