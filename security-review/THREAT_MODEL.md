# SquishyBot — Threat Model

## Assets
- **Guild integrity** — role assignments (especially the 7 staff roles and any moderation roles), channel structure, voice rooms.
- **The Discord bot token** (`DISCORD_BOT_TOKEN`) — full control of the bot identity.
- **The RPC HMAC secret** (`BOTPANEL_RPC_SECRET`) — sole authentication for privileged cross-service commands.
- **Postgres data** — user profiles (incl. birthdays and staff "real_name" PII), settings, channel/feed state.
- **Deploy credentials** — `VPS_SSH_KEY`, GHCR push token, Discord deploy webhook.
- **Availability** — the bot is single-process / single-threaded; freezing the event loop is a full outage.

## Trust boundaries
1. **Discord member → bot.** Any guild member can invoke slash commands and click buttons/selects/modals and add reactions. customIds and select `values` are **client-controlled** and must never be trusted for authorization.
2. **botpanel / Redis network → bot.** The bot `psubscribe`s to `cmd.squishy.*` on a Redis instance shared across multiple bots on the external `botpanel-net`. Authentication is a single shared HMAC secret; there is **no per-actor identity** in the envelope (confused-deputy by design).
3. **Remote feed/host → bot.** The social poller fetches operator-configured RSS URLs and parses arbitrary remote content. Redirects can point the fetch somewhere the operator never configured.
4. **GitHub Actions / PR → deploy.** PRs trigger the workflow (build-validate only); push-to-main builds, pushes to GHCR, and SSH-deploys to the VPS.

## Attackers
- **Malicious guild member** — wants to self-grant staff/mod roles, grief voice rooms, or take down the bot.
- **Co-tenant on `botpanel-net`** — another bot/container (or a compromised one) that can reach the password-less Redis and DB.
- **Malicious/compromised RSS host or aggregator** — controls feed response bodies and redirects.
- **Supply-chain attacker** — compromises a dependency or a floating-tag GitHub Action.
- **Network eavesdropper on the shared bus** — reads/injects/replays Redis messages.

## Attack paths (and disposition)
| Path | Boundary | Disposition |
|---|---|---|
| `color:pick` with arbitrary role id → self-grant staff/mod | 1 | **Fixed** (H1) |
| `rxnroles.create` with privileged role → react → self-grant | 2 | **Fixed** (H2, guarded at create + grant sink) |
| Hostile feed body of unclosed `<item>` → event-loop freeze | 3 | **Fixed** (H3) |
| Public feed 302 → internal address → SSRF probe | 3 | **Fixed** (M1) |
| Co-tenant publishes `staff.grant`/`voice.*` with the secret | 2 | **Residual** — depends on Redis auth (H6) + secret secrecy; app-level confused-deputy is by design |
| Co-tenant connects to DB with weak/guessable password | 2 | **Hardened** (M2 fail-loud) + **residual** (strong password is operator's job) |
| Replay captured invalidate message → DB reload amplification | 2 | **Fixed** (L4) |
| RCE in bot → root in container → pivot on shared net | 1/2/3 | **Reduced** (H4 non-root) |
| Schema diff at boot drops production columns/data | ops | **Fixed** (H5 — committed migrations + backup gate, replaced `push --force`) |
| Compromised floating-tag action runs in SSH-key deploy job | 4 | **Residual** (L2 — pin to SHA) |
| Fork PR exfiltrates secrets | 4 | **Not exploitable** — secrets/SSH/push steps gated on `push` to `main`; fork `GITHUB_TOKEN` is read-only by policy; top-level perms now `contents: read` |

## High-risk components
- `src/services/rpc/handlers/**` — privileged verbs (role grants, channel ops) behind a single shared secret.
- `src/services/social/poller.ts` + `rssParser.ts` — the only path that ingests untrusted *remote* bytes.
- `src/utils/roleGuard.ts` (new) — the chokepoint now protecting every member-facing role grant.
- `scripts/docker-entrypoint.sh` — destructive DDL authority at boot.

## Blast radius
The single biggest blast-radius amplifier is the **shared external `botpanel-net`** with an
**unauthenticated Redis** and (formerly) a **weakly-defaulted Postgres password**, combined with
a (formerly) **root** container. A compromise of any one co-tenant could reach every bot's bus and
DB. This review shrinks that radius (non-root container, fail-loud DB password, redis-auth nudge,
replay window) but the decisive control — Redis `requirepass` / network segmentation — is an
**operator action** (H6) outside this repo's code.
