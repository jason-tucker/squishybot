# H5 — Migration cutover runbook

**Finding:** the container ran `drizzle-kit push --force` on every boot, which
auto-approves destructive DDL (column/table drops) unattended, with no backup.

**Fix:** the container now applies **committed SQL migrations** with the
drizzle-orm `migrate()` runner (`node dist/db/migrate.js`), forward-only and
fail-closed. This runbook covers the one-time cutover from the legacy
`push`-built production DB.

---

## TL;DR — the happy path is automatic

`src/db/migrate.ts` contains a **self-baseline guard**. On the first deploy of
this change it detects the legacy state (app tables present, no drizzle ledger)
and records the baseline migration as *already applied*, so `migrate()` does
**not** try to recreate existing tables. You do not have to run any SQL by hand,
and the deploy is safe in any order. The deploy workflow also takes a `pg_dump`
backup before starting the new image.

What you SHOULD still do: keep an eye on the first deploy's logs, and ideally run
the verification in §2 once so you have confidence the committed baseline matches
your live schema.

---

## 1. What changed

| Before | After |
|---|---|
| `scripts/docker-entrypoint.sh` → `drizzle-kit push --config=… --force` | `scripts/docker-entrypoint.sh` → `node dist/db/migrate.js` |
| Migrations gitignored / dockerignored (schema lived only in code) | Migrations **committed**; baseline `src/db/migrations/0000_init.sql` (20 tables) copied into the image |
| Destructive diffs applied silently, unattended | Forward-only; a bad migration **aborts startup** (fail-closed) |
| No backup | Deploy workflow runs `pg_dump` → `./backups/squishybot-<ts>.sql.gz` (keeps 14) before bring-up |

**Baseline identity** (for manual baselining / verification):

| field | value |
|---|---|
| tag | `0000_init` |
| journal `when` | `1781050773826` |
| sha256 of `0000_init.sql` | `263265c570db5e1a6a7cf491b53a66a82cee62b50dfaf437d5ca690d93cfd7d2` |

> The runtime skip logic uses only `created_at` (= `when`); the `hash` column is
> recorded for bookkeeping and is not used to decide what runs.

---

## 2. Verify the baseline matches live prod (recommended, run once)

Confirm the committed baseline reproduces the schema that `push` built, so future
`generate` diffs start from a faithful baseline. Run on the VPS, in `PROJECT_DIR`:

```bash
# (a) schema-only dump of the LIVE DB (built by the old push)
docker compose exec -T db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --schema-only -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > /tmp/prod_schema.sql

# (b) build a scratch DB from the committed baseline and dump it
docker compose exec -T db psql -U "$POSTGRES_USER" -c 'CREATE DATABASE baseline_check;'
docker compose exec -T db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d baseline_check' \
  < src/db/migrations/0000_init.sql
docker compose exec -T db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --schema-only -U "$POSTGRES_USER" -d baseline_check' \
  > /tmp/baseline_schema.sql

# (c) compare (object set; ignore ordering/whitespace noise)
diff <(grep -E 'CREATE (TABLE|INDEX|UNIQUE)|ALTER TABLE|CONSTRAINT' /tmp/prod_schema.sql | sort) \
     <(grep -E 'CREATE (TABLE|INDEX|UNIQUE)|ALTER TABLE|CONSTRAINT' /tmp/baseline_schema.sql | sort)

# cleanup
docker compose exec -T db psql -U "$POSTGRES_USER" -c 'DROP DATABASE baseline_check;'
```

A clean (empty) diff means the baseline faithfully represents prod. Investigate
any difference before relying on future generated migrations.

---

## 3. Cutover

1. Merge the PR to `main`. The deploy workflow:
   - takes the `pg_dump` backup gate (aborts the deploy if it fails),
   - pulls the new image,
   - the container starts → `migrate()` runs → self-baseline records `0000_init`
     as applied → no DDL is executed against the existing schema → bot starts.
2. Watch the deploy run and the container logs. On a legacy DB you will see:
   `▶ Baselined legacy DB: marked 0000_init as already-applied …` then
   `✅ Migrations complete.`

### Manual baseline (fallback / explicit)

If you prefer to baseline by hand *before* deploying (the guard then sees the
ledger already populated and does nothing):

```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('263265c570db5e1a6a7cf491b53a66a82cee62b50dfaf437d5ca690d93cfd7d2', 1781050773826);
```

This is harmless to the currently-running (push-based) bot — it only adds a
tracking table the old image ignores.

---

## 4. Rollback

A migration is only as safe as its backup. To restore the pre-deploy snapshot:

```bash
cd "$PROJECT_DIR"
LATEST=$(ls -1t ./backups/squishybot-*.sql.gz | head -1)
echo "Restoring $LATEST"
docker compose stop squishybot
gunzip -c "$LATEST" | docker compose exec -T db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# then redeploy the previous image tag, or `docker compose up -d squishybot`
```

To roll back the **image**, pin the previous `sha-...` tag (from GHCR) via
`BOT_IMAGE` and `docker compose up -d`, instead of `:latest`.

---

## 5. Day-to-day: changing the schema after cutover

1. Edit `src/db/schema/*.ts`.
2. `pnpm db:generate` → review the new `src/db/migrations/NNNN_*.sql` (check any `DROP`).
3. `pnpm db:check` (optional consistency check), then commit the `.sql` + snapshot
   **with** the schema change.
4. Deploy. The startup runner applies it forward-only; the backup gate keeps it
   recoverable. Never use `drizzle-kit push` against production.

## 6. Disaster recovery (fresh DB from scratch)

A brand-new empty DB is created entirely from the committed migrations: the guard
sees no app tables, skips baselining, and `migrate()` runs `0000_init.sql`
(which begins with `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`) followed by any
later migrations. No manual steps.
