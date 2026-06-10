# Security Changelog — `claude/stoic-cannon-11exy5`

Branch base: `1fbb135` (main). 7 commits, +270/−26 across 15 files. No DB migration.

## Fixed
- **[H1] Privilege escalation via `/color`** — the color picker added `interaction.values[0]` as a
  role without checking it was a configured color role, letting any member self-grant any
  bot-manageable role (incl. staff). Now validated against the configured set and a shared
  assignability guard; feature flag re-checked on the handler. (`de7fe55`)
- **[H2] Privilege escalation via `rxnroles.create`** — reaction-role mappings accepted any
  snowflake-shaped role id, enabling self-assignment of privileged roles via reactions. Added a role
  assignability guard at creation (new `bad-role` error) and at the actual reaction grant sink.
  (`de7fe55`)
- **[H3] ReDoS in the RSS parser** — a lazy regex item/entry matcher backtracked quadratically on
  unclosed `<item>` opens, letting a hostile feed freeze the single-threaded bot. Replaced with a
  linear `indexOf` scan capped at 500 items (900k-open input now parses in ~14ms). (`c44c627`)
- **[M1] SSRF via redirect** in the RSS poller — `redirect:'follow'` bypassed the private-IP
  allowlist. Now follows ≤5 redirects manually, re-validating every hop. (`c44c627`)
- **[H4] Container ran as root** — added `USER node` to the production image stage. (`a185988`)
- **[M2] Weak default DB password** — the bot now logs a non-fatal startup
  warning when it detects the weak `squishybot_dev` default in `DATABASE_URL`.
  (`a185988`; intentionally **non-breaking** — the compose fallback is retained
  so an existing deploy isn't broken on upgrade.)
- **[L1] HMAC secret not redacted** — `BOTPANEL_RPC_SECRET` added to the logger's redaction list.
  (`240a1e0`)
- **[L3] `ws` CVE-2026-45736** — pnpm override `ws@^8.20.1` (resolves 8.21.0). (`d8aed0e`)
- **[L4] Replay window** — cache-invalidate now enforces the same ±30s timestamp window as the RPC
  server. (`3acb434`)

## Added / hardened
- **[L5] Docs** — `.env.example` now documents `BOTPANEL_RPC_SECRET` and `REDIS_URL` with security
  guidance, and notes `POSTGRES_PASSWORD` is now required. (`240a1e0`)
- **[H6] Startup nudge** — the RPC server warns when `REDIS_URL` has no password. (`3acb434`)
- **[I1] CI least-privilege** — top-level `permissions: contents: read` on the deploy workflow.
  (`1dba7fb`)
- New shared `src/utils/roleGuard.ts` — single chokepoint for "is this role safe to grant?".

## Behaviour changes
- DB password (M2): **non-breaking** — compose keeps the `squishybot_dev`
  fallback; the bot only logs a startup warning when the weak default is in use.
- The production container now runs as the unprivileged `node` user.

## Also fixed (follow-up)
- **[H5]** Replaced `drizzle-kit push --force` at boot with a committed-migration runner:
  generated baseline (`src/db/migrations/0000_init.sql`), forward-only fail-closed startup
  `migrate()`, a `pg_dump` pre-deploy backup gate, and a self-baseline guard for the legacy
  push-built DB. Migrations are now committed (out of `.gitignore`/`.dockerignore`). See
  `H5_MIGRATION_CUTOVER.md`.

## Not changed (documented for follow-up — see REMEDIATION_PLAN.md)
- **[H6 server side]** Redis `requirepass` on the shared bus — operator/infra action.
- **[L2]** Pin GitHub Actions to commit SHAs — needs GitHub API access to resolve SHAs safely.
- **[I1 full]** Split PR-validate from main-deploy jobs.
