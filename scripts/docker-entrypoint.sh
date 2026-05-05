#!/bin/sh
set -e

echo "▶ Applying database schema (drizzle-kit push)..."
# --force auto-approves all changes including column drops.
# Safe here because the developer controls both schema and data.
node_modules/.bin/drizzle-kit push \
  --config=drizzle.docker.config.cjs \
  --force

echo "▶ Starting SquishyBot..."
exec node dist/index.js
