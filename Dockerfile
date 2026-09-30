# syntax=docker/dockerfile:1
# SSDiskDB Docker image.
#
# The image is built locally from this repository (or from the npm package
# published from it). SSDiskDB itself is NOT pulled from Docker Hub. Only the
# generic Node.js LTS base image comes from a registry.
#
# Build:
#   docker compose build
#   docker build -t ssdiskdb .
#
# Run:
#   docker compose up -d

# Stage 1: build the npm package's runtime artifacts from source.
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools required by the `level` native addon (LevelDB bindings).
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: minimal production runtime.
FROM node:20-alpine

WORKDIR /app

# Copy only what the runtime needs: package metadata, compiled dist, and the
# native node_modules. Source, tests, and build tooling stay out of the image.
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/proto ./proto
COPY --from=builder /app/README.md ./README.md
COPY --from=builder /app/LICENSE ./LICENSE

# Persistent database directory. The compose file bind-mounts the host path
# here, so data survives container restarts and recreations.
RUN mkdir -p /data/ssdb-local-db

# Dashboard port.
EXPOSE 8971

# Default environment variables. They can be overridden at runtime:
#   SSDISKDB_PORT       - dashboard HTTP port (default 8971)
#   SSDISKDB_DATA_DIR   - LevelDB database directory (default /data/ssdb-local-db)
#   SSDISKDB_USERNAME   - initial admin username (only applied if no creds exist)
#   SSDISKDB_PASSWORD   - initial admin password (only applied if no creds exist)
ENV SSDISKDB_PORT=8971
ENV SSDISKDB_DATA_DIR=/data/ssdb-local-db

# Persistent volume for the database directory.
VOLUME ["/data/ssdb-local-db"]

# Health check: the dashboard exposes /health (unauthenticated) and returns
# {"status":"ok"} only when the server is actually listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:${SSDISKDB_PORT:-8971}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the SSDiskDB local engine + dashboard. The server binds to 0.0.0.0 so
# the published host port reaches it.
CMD ["node", "dist/cjs/cli.js", "start", "--port", "8971", "--path", "/data/ssdb-local-db"]