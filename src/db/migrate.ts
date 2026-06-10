import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import 'dotenv/config'

const MIGRATIONS_FOLDER = './src/db/migrations'

/**
 * One-time, idempotent transition guard.
 *
 * Production was historically built by `drizzle-kit push --force`, so the live
 * DB has every app table but NO drizzle migration ledger. If we hand that DB
 * straight to `migrate()`, the baseline migration's bare `CREATE TABLE`
 * statements would fail with "already exists" and crash the container.
 *
 * Detect exactly that state — app tables present, ledger absent/empty — and
 * record ONLY the earliest migration as already-applied. `migrate()` then
 * treats the existing schema as the baseline (its skip logic is purely
 * `max(created_at) < migration.when`) and applies only newer migrations.
 *
 * Fresh DBs (no app tables) are left untouched so `migrate()` creates
 * everything from scratch. DBs already managed by `migrate()` (non-empty
 * ledger) are left untouched too. This makes the cutover safe in any order:
 * the operator does not have to baseline by hand before deploying.
 */
async function baselineLegacyDbIfNeeded(client: postgres.Sql): Promise<void> {
  // Already managed by migrate()? (ledger exists AND has at least one row)
  const ledger = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`
  if (ledger[0]?.t != null) {
    const rows = await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    if ((rows[0]?.n ?? 0) > 0) return
  }

  // Fresh DB? Let migrate() create the whole schema from the baseline.
  const appTable = await client`SELECT to_regclass('public.auto_channels') AS t`
  if (appTable[0]?.t == null) return

  // Legacy push-built DB: baseline the earliest migration as already-applied.
  const journal = JSON.parse(
    readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'),
  ) as { entries: Array<{ when: number; tag: string }> }
  const first = [...journal.entries].sort((a, b) => a.when - b.when)[0]
  const sqlText = readFileSync(`${MIGRATIONS_FOLDER}/${first.tag}.sql`, 'utf8')
  const hash = createHash('sha256').update(sqlText).digest('hex')

  await client`CREATE SCHEMA IF NOT EXISTS drizzle`
  await client`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`
  await client`INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES (${hash}, ${first.when})`
  console.log(
    `▶ Baselined legacy DB: marked ${first.tag} as already-applied (existing schema came from drizzle-kit push).`,
  )
}

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    await baselineLegacyDbIfNeeded(client)
    const db = drizzle(client)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    console.log('✅ Migrations complete.')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
