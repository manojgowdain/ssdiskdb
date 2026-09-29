# Stage 1: Build TypeScript codebase
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native addon compilation (LevelDB dependencies)
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Minimal production environment
FROM node:20-alpine

WORKDIR /app

# Copy necessary runtimes and node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create persistent database folder
RUN mkdir -p /data

# Default configurations
EXPOSE 8971
ENV PORT=8971
ENV PATH_DB=/data

# Persistent eldb volume
VOLUME ["/data"]

# Run the SSDiskDB dashboard server
CMD ["node", "dist/cjs/cli.js", "start", "--port", "8971", "--path", "/data"]
