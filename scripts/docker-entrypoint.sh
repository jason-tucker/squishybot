#!/bin/sh
set -e

echo "▶ Running database migrations..."
node dist/db/migrate.js

echo "▶ Starting SquishyBot..."
exec node dist/index.js
