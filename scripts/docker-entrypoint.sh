#!/bin/sh
set -e

# Apply committed, reviewed SQL migrations (drizzle-orm migrate runner).
# Forward-only: it never drops anything that a migration file doesn't ask for,
# and it fails closed — a bad migration aborts startup instead of silently
# mutating data the way the old `drizzle-kit push --force` did. The runner also
# self-baselines a legacy push-built DB on first run (see src/db/migrate.ts).
echo "▶ Running database migrations..."
node dist/db/migrate.js

echo "▶ Starting SquishyBot..."
exec node dist/index.js
