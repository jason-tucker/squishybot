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

# Copy compiled output and production node_modules from build stage
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Copy SQL migration files — migrate.ts reads these at runtime
COPY src/db/migrations ./src/db/migrations

# Copy entrypoint
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["./docker-entrypoint.sh"]
