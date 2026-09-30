# SSDiskDB Docker/Compose + Official Installation Plan

**Goal:** Make SSDiskDB installable natively and via locally-built Docker Compose, with the official installer served at ssdiskdb.js.org, fixed credential messaging, a /health endpoint, env-var configuration, updated docs/website, and verified end-to-end.

**Architecture:** Reuse the existing CLI (`src/cli.ts`), dashboard server (`src/dashboard.ts`), and `connect()` factory (`src/index.ts`). Add env-var support (SSDISKDB_PORT, SSDISKKDB_DATA_DIR, SSDISKDB_USERNAME/PASSWORD), a `/health` endpoint, `--version`, and credential-state-aware startup output. Ship `docker-compose.yml`, a rebuilt `Dockerfile`, `docker-install.sh`, updated `install.sh`, rewritten `index.html` + `readme.md`, and a GitHub Actions CI workflow.

**Spec:** User pasted requirements (sections 1-37).

## Global Constraints
- No Docker Hub for SSDiskDB image; build locally from repo.
- Docker image installs `@manojgowdain/ssdiskdb` via npm.
- Official URLs: `https://ssdiskdb.js.org/install.sh` and `https://ssdiskdb.js.org/docker-install.sh`.
- Remove/stop advertising `raw.githubusercontent.com/.../install.sh`.
- Port 8971 default; server binds 0.0.0.0 in Docker.
- Persist data across restart/down-up.
- No hardcoded personal paths, no secrets, no password printing.
- Preserve backward compatibility; don't break existing CLI/DB functionality.

## Review Focus
1. Credential change actually persists and login succeeds with new creds (not just message fix).
2. `/health` returns 200 only when server is up; used by Docker HEALTHCHECK.
3. Docker bind is 0.0.0.0 so host port publish works.
4. Data survives `docker compose restart` and `down`+`up`.
5. npm package contains all files needed by `npx ssdiskdb start`.

## Tasks
- T1: Core fixes — env vars, --version, /health, credential startup message.
- T2: Dockerfile + docker-compose.yml.
- T3: install.sh + docker-install.sh.
- T4: Website index.html + sitemap + robots.
- T5: README rewrite.
- T6: GitHub Actions CI.
- T7: Tests + full verification.