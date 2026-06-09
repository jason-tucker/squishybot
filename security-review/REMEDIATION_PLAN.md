# SquishyBot — Remediation Plan

All code fixes landed on branch `claude/stoic-cannon-11exy5` as 7 atomic, independently-reviewable
commits, in auto-fix priority order (escalation → DoS/SSRF → infra → supply chain → hardening).

## Fixed in this branch

| Commit | Unit | Findings | Files | Verification |
|---|---|---|---|---|
| `de7fe55` | Role-assignment hardening | H1, H2 | `utils/roleGuard.ts` (new), `commands/color.ts`, `rpc/handlers/rxnroles/create.ts`, `bot/events/messageReaction.ts` | typecheck; logic traced |
| `c44c627` | RSS feed hardening | H3, M1 | `services/social/rssParser.ts`, `services/social/poller.ts` | ReDoS benchmark + redirect test |
| `a185988` | Container & compose hardening | H4, M2 | `Dockerfile`, `docker-compose.yml` | `docker compose config` |
| `240a1e0` | Secret hygiene & config docs | L1, L5, H6(doc) | `services/logger.ts`, `.env.example` | typecheck |
| `3acb434` | RPC runtime hardening | L4, H6(warn) | `services/cacheInvalidator.ts`, `services/rpcServer.ts` | typecheck + regex test |
| `d8aed0e` | Dependency bump | L3 | `package.json`, `pnpm-lock.yaml` | `pnpm audit` 2→1, `--frozen-lockfile` |
| `1dba7fb` | CI/CD least-privilege | I1 | `.github/workflows/deploy.yml` | YAML lint |

## Requires human / operator action (documented, not auto-applied)

### H5 — Replace `drizzle-kit push --force` at boot with reviewed migrations  *(High)*
`scripts/docker-entrypoint.sh` runs `drizzle-kit push --config=… --force` on **every** container
start; `--force` auto-approves destructive DDL (column/table drops). With watchtower auto-deploying
`:latest`, an unintended schema diff can drop production data unattended with no backup.
**Recommended:** generate versioned migrations (`drizzle-kit generate`) reviewed in PRs; apply them
as an explicit, gated deploy step (after a DB backup), not unattended at boot. As an interim guard,
take a `pg_dump` before each deploy and drop `--force` so non-additive diffs require explicit review.
*Risk of auto-applying:* high (could break the deploy or change schema behaviour) — left for the maintainer.

### H6 (server side) — Authenticate Redis on the shared bus  *(High)*
The command bus reduces to "who can reach Redis + knows the HMAC secret." Redis has no password and
lives on the shared `botpanel-net`. **Recommended:** set `requirepass` on the Redis server (botpanel
stack) and use `REDIS_URL=redis://:<password>@redis:6379` here; ideally segment the network so only
intended peers attach. The bot now **warns at startup** when `REDIS_URL` has no password, and
`.env.example` documents the secure form. The server-side change is outside this repo.

### L2 — Pin third-party GitHub Actions to commit SHAs  *(Low)*
`appleboy/ssh-action@v1.2.0` (holds `VPS_SSH_KEY`) and the `docker/*` actions use floating tags.
**Recommended:** pin each to a full commit SHA (`uses: appleboy/ssh-action@<sha> # v1.2.0`);
Dependabot's `github-actions` updater (already configured) keeps them current. *Not auto-applied:*
resolving authoritative SHAs requires GitHub API access, which was blocked from the review
environment — guessing a SHA would break the deploy.

### I1 (full) — Split PR-validate from main-deploy jobs  *(Info)*
A top-level `permissions: contents: read` now applies, but the deploy job still declares
`packages: write` (used only on `push` to `main`). To remove that grant from PR runs entirely, split
into two jobs (`validate` for PRs with `contents: read`; `build-push-deploy` for main). *Not
auto-applied:* restructuring a live deploy pipeline for an Info finding carries more breakage risk
than benefit; left for the maintainer.

### I2 — Restrict `meta.*` roster disclosure  *(Info)*
Resolved transitively by securing the bus (H6). No code change recommended in isolation.

## Residual risks after this branch
- Confused-deputy on the RPC bus is **by design** (the panel is trusted). Acceptable once Redis is authenticated (H6); to go further, carry a signed acting-user identity in the envelope and re-check it bot-side before role mutations.
- Intermediate 3xx redirect response bodies in `poller.ts` are not explicitly cancelled (undici GC-cleans them; ≤5 short-lived hops) — negligible.
- `esbuild` moderate advisory remains (dev/build-only via `drizzle-kit`); not exploitable at runtime. Resolves when `drizzle-kit` is removed from the runtime image (tied to H5) or upgraded.
- DNS-rebinding TOCTOU on the SSRF allowlist (pre-existing, acknowledged in code) — out of scope for the "rogue sudo" threat model; a `connect`-hook socket-level check would close it.
