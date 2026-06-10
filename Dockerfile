# ── Stage 1: Build ────────────────────────────────────────────────────────────
# TypeScript compilation runs HERE (on the CI runner with 7 GB RAM),
# never on the production server.
FROM node:24-alpine AS builder

RUN corepack enable pnpm

WORKDIR /build

# Install all deps first (layer cache — only re-runs when lockfile changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and compile
COPY . .
RUN node --max-old-space-size=4096 node_modules/typescript/bin/tsc

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

# Copy compiled output and all node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Committed SQL migrations — the startup migrate runner reads these from
# ./src/db/migrations (relative to WORKDIR). They are plain .sql, not compiled
# into dist/, so they must be copied explicitly.
COPY --from=builder /build/src/db/migrations ./src/db/migrations

# Entrypoint: applies migrations then starts the bot
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

# Drop root: the node:*-alpine image ships an unprivileged `node` user (uid
# 1000). Running the bot as root means any RCE / malicious-dependency code
# executes as root inside the container — larger blast radius on the shared
# docker network. All copied files are world-readable and the bot writes only
# to stdout + the DB, so the unprivileged user is sufficient.
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
