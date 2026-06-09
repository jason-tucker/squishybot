# SquishyBot — Deployment & Rollback (this security branch)

## Deployment status: **NOT deployed.** Changes are committed to `claude/stoic-cannon-11exy5` only.

No staging or production deploy was performed. There is no reachable staging target from the review
environment, and production deploy requires explicit operator approval (per the review's safety
rules). The pipeline itself (`.github/workflows/deploy.yml`) only deploys on **push to `main`**, so
nothing ships until this branch is merged.

## Pre-merge / pre-deploy checklist
- [x] `pnpm install --frozen-lockfile` succeeds (lockfile consistent after the `ws` override)
- [x] `pnpm typecheck` green at HEAD
- [x] ReDoS fix benchmarked (900k unclosed `<item>` → ~14ms; 700k items → capped at 500, ~20ms)
- [x] SSRF redirect behaviour verified against a local 302 server
- [x] `docker compose config` interpolation validated (`POSTGRES_PASSWORD` now required)
- [ ] **Operator:** confirm `.env` on the VPS sets a strong `POSTGRES_PASSWORD` *before deploying* — compose now **fails to start** if it is unset/empty (intended; see Behaviour changes).
- [ ] **Operator:** confirm the bot can run as non-root (it writes only to stdout + DB; no host bind-mount needs root)

## Behaviour changes to be aware of (two intentional fail-closed hardenings)
1. **`docker compose up` now errors if `POSTGRES_PASSWORD` is unset/empty** (was: silent fallback to `squishybot_dev`). Set it in `.env` first. This is the fix for M2.
2. **The container now runs as the unprivileged `node` user** (was: root). If any future change needs to write inside the image filesystem, it must target a world-writable path (e.g. `/tmp`) or a mounted volume with appropriate ownership.

No database migration is introduced by this branch. (The pre-existing `drizzle-kit push --force`
at boot is unchanged and is flagged separately as **H5** for follow-up — see `REMEDIATION_PLAN.md`.)

## Build & verify (CI does this automatically on the PR)
```bash
pnpm install --frozen-lockfile
pnpm typecheck
docker build -t squishybot:review .        # multi-stage; compiles TS in the builder
```

## Rollback
This branch is behaviour-preserving except the two fail-closed hardenings above; rollback is a
standard image revert — **no data migration to undo**.

```bash
# On the VPS — pin a previous known-good image and bring the stack up
BOT_IMAGE=ghcr.io/jason-tucker/squishybot:sha-<previous_sha> docker compose up -d
# Find previous SHAs in GitHub → Actions → the deploy run → "Docker metadata" step
```
If the rollback is because the non-root container can't start, the root cause is almost certainly a
filesystem-write expectation — confirm with `docker compose logs squishybot --tail=50`; the fix is a
writable volume/path, not reverting to root.

## Post-deploy monitoring
- `docker compose ps squishybot` shows `running/Up`.
- `docker compose logs squishybot --tail=50` — look for the new startup line
  `rpcServer: REDIS_URL has no password …` (the H6 nudge) and confirm whether you intend to act on it.
- The optional `UPTIME_KUMA_PUSH_URL` heartbeat and `LOG_CHANNEL_ID` continue to work unchanged.
