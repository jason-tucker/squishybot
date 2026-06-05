# SquishyBot

A multipurpose Discord bot for a single server, built around **dynamic auto voice channels** with attached text channels and interactive control panels. discord.js v14 · TypeScript · PostgreSQL · Drizzle ORM.

## Overview

SquishyBot serves one Discord guild. Its headline feature is auto voice channels: members join a **hub** voice channel and the bot converts it into their own room — renamed in place, with a private text channel and a persistent Components V2 control panel. A replacement hub is spawned immediately, and rooms clean themselves up when empty. A startup **reconciler** repairs orphaned channels, missing hubs, and stale panels after every restart.

Around that core, the bot bundles game roles + LFG pings (`/play`), self-service profiles and birthdays, staff-role requests, auto-threads, social-feed reposting, reaction roles, channel archiving, and an owner-reviewed `/report → GitHub issue` flow. Almost everything is configurable at runtime through `/sudo → Settings` — no redeploy needed to onboard a new hub, game, or auto-thread channel.

A companion web dashboard ([botpanel](https://github.com/jason-tucker/botpanel)) drives the same actions over a Redis command bus, so the bot exposes most flows as both Discord interactions and RPC verbs.

Roadmap, completed work, and open action items live on the [Bot Development project board](https://github.com/users/jason-tucker/projects/3). Items use statuses **Todo**, **In Progress**, **Done**, **Tucker Action** (waiting on the owner), and **Blocked** (with a Blocker note).

## Architecture

### Auto voice system

When a member joins a hub voice channel, `voiceStateUpdate → handleHubJoin` runs:

1. The hub VC is **renamed in place** and moved to the top of the category — the member stays put, no move needed.
2. A **replacement hub** is created so the entry point is never consumed.
3. An attached **text channel** is created, denied to `@everyone` and granted to the owner, members currently in the VC, the bot, and sudo roles.
4. A **control panel** (Components V2) is posted silently in the text channel, plus a sticky **📋 Open Panel** button pinned to the bottom.
5. An `auto_channels` row records the full state (owner, hosts, lock/hide flags, user limit, name template, panel message ID).

Channel names track Discord **rich presence** for every member in the room (not just the owner); with nobody playing, the name falls back to a manual name or a random tech-themed default (e.g. *Sloppy Ethernet*). When the room empties, a DB-backed **cleanup scheduler** deletes both channels after a configurable delay. Ownership uses a **grace window** (default 5 min) so an owner who briefly leaves can reclaim before an acting owner is promoted.

Key services live under `src/services/voice/`: `hubManager`, `autoChannel`, `autoNaming`, `controlPanel`, `sticky`, `cleanupScheduler`, `ownerGrace`, `hubLockdown`, `hostsService`, `permissions`, `reconciler`.

### Reconciler

`runReconciler()` runs on `clientReady` and is the bot's self-repair pass. It seeds hubs from env, reconciles every `auto_channels` row against live Discord state (cleaning orphaned rows, rebuilding panels and stickies, re-syncing text-channel permissions), backfills the member list, and restores in-flight cleanup timers, owner-grace windows, and hub lockdowns. Untracked channels in the auto-voice category are logged but left alone (never auto-adopted).

### Data + integration

- **PostgreSQL + Drizzle ORM**, 19 tables. Schema lives only in `src/db/schema/*.ts` — applied with `drizzle-kit push` (no SQL migration files in git). See the [Database Schema wiki](https://github.com/jason-tucker/squishybot/wiki/Database-Schema).
- **Runtime config** is stored in `bot_settings` (key/value, with env fallback) and edited live via `/sudo → Settings`. Feature flags, channel IDs, hub list, games, social feeds, and more are all DB-authoritative.
- **Redis** carries a fan-out **event bus** (`bot.squishy.*` — ready/heartbeat/voice/member events) and a botpanel **command bus** (`cmd.squishy.<verb>`, HMAC-signed). RPC handlers under `src/services/rpc/handlers/` mirror the slash flows. Both are optional: with `BOTPANEL_RPC_SECRET` unset or Redis down, the bot runs normally.

## Stack

| Layer | Tool |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Node 24, `node dist/index.js` (compiled JS in Docker) |
| Discord | discord.js v14 (Components V2) |
| Database | PostgreSQL 16 + Drizzle ORM |
| Schema | `drizzle-kit push` (no SQL files in git) |
| Cache/bus | Redis (ioredis) — optional event + command bus |
| Env | Zod-validated `.env` |
| Dev runner | `tsx watch` |
| CI/CD | GitHub Actions → GHCR → watchtower |

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your values — see Configuration below
```

### 3. Apply the database schema

Schema lives only in `src/db/schema/*.ts`. The Docker entrypoint runs `drizzle-kit push` automatically on every start. For local non-Docker dev:

```bash
pnpm drizzle-kit push
```

### 4. Deploy slash commands

```bash
pnpm deploy:commands
```

### 5. Start

```bash
pnpm dev          # local dev (tsx, hot reload)
# or, in production, via Docker — see Deployment
```

## Configuration

All variables are validated by Zod in `src/config/env.ts`; the bot exits on a missing required value. In Docker, `DATABASE_URL` and `REDIS_URL` are set for you by `docker-compose.yml` (you only set `POSTGRES_PASSWORD`).

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application (client) ID |
| `GUILD_ID` | Yes | The single guild this bot serves |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Set automatically by Docker Compose from `POSTGRES_PASSWORD`. |
| `AUTO_VOICE_CATEGORY_ID` | Yes | Default category for hubs and auto channels (overridable via `/sudo → Settings → Voice`) |
| `NODE_ENV` | No | `development` / `production` / `test` (default: `development`) |
| `HUB_CHANNEL_IDS` | No | Comma-separated voice channel IDs to seed as hubs on first boot. Once registered the DB is authoritative; manage at runtime via `/sudo → Settings → Hub Channels`. |
| `SUDO_ROLE_IDS` | No | Comma-separated role IDs with admin powers |
| `SUDO_USER_IDS` | No | Comma-separated user IDs with admin powers |
| `BOT_OWNER_ID` | No* | Receives startup + error DMs. *Required for `/report` review and bot-owner kill switches. Bot-owner status can also resolve from the Discord dev-portal Team. |
| `LOG_CHANNEL_ID` | No | Channel for structured bot log messages |
| `ADMIN_CHANNEL_ID` | No | Sudo-only bot admin channel |
| `STAFF_APPROVAL_THREAD_ID` | No | Thread where staff-role requests are posted |
| `STAFF_APPROVAL_PING_USER_ID` | No | User pinged on each staff request |
| `VOICE_CLEANUP_DELAY_MS` | No | ms before empty channels are cleaned up (code default `0`; `.env.example` seeds `30000`). Overridable via `/sudo → Settings → Voice`. |
| `BIRTHDAY_CHANNEL_ID` | No | Birthday-ping channel (also editable at `/sudo → Settings → Channels`) |
| `GITHUB_TOKEN` | No* | Fine-grained PAT with **Issues: Read & Write** on `GITHUB_REPO`. *Required for `/report`. |
| `GITHUB_REPO` | No* | `owner/name`, e.g. `jason-tucker/squishybot`. *Required for `/report`. |
| `BOTPANEL_RPC_SECRET` | No | Shared HMAC secret with botpanel for the Redis command/cache bus. Unset → RPC + cache-invalidate subscribers disabled (bot still runs). |
| `REDIS_URL` | No | Event/command bus. Set by Docker Compose (`redis://redis:6379`). |
| `BOT_IMAGE` | No | GHCR image for `docker compose pull` (default `ghcr.io/jason-tucker/squishybot:latest`). Set by CI. |
| `POSTGRES_PASSWORD` | No | Postgres password for the Compose-managed DB. Use alphanumeric/hex (avoid `#`, `*`, `?`). |
| `UPTIME_KUMA_PUSH_URL` | No | Push-monitor URL; pinged every 60s |
| `CLIPS_CHANNEL_ID`, `FOOD_CHANNEL_ID` | — | **Deprecated.** Auto-threading is configured at `/sudo → Settings → Auto Threads` (DB-backed). Safe to remove. |

## Usage

Nine commands are registered: eight slash commands plus one right-click context menu. All responses are ephemeral. Full reference: the [Slash Commands wiki](https://github.com/jason-tucker/squishybot/wiki/Slash-Commands).

| Command | Access | Description |
|---|---|---|
| `/help` | Everyone | Bot status + feature explainers (Voice / Panel / Games / Game Night / Staff / Reports). Routes self-service edits to `/settings`. |
| `/settings` | Everyone | Self-service: **Profile & Birthday**, **Game Prefs**, **Staff Role** (request / remove). |
| `/voice` | Owner / host / sudo | Open an ephemeral copy of the control panel for the auto channel you're in. |
| `/games` | Everyone | Pick which games you want View access + LFG pings for. |
| `/play <game>` | Everyone | LFG ping. Posts a Components V2 message in the game's channel with a **🎮 I want to play!** join button. Optional `message` / `ping` options; 30-min per-(user, game) cooldown (`force:true` for sudo). |
| `/report` | Everyone | Modal (Title / Type / Description / Steps) → DMs the owner with **Approve+Notify** / **Approve Silent** / **Reject+Notify** / **Reject Silent** → on approve, files a GitHub issue against `GITHUB_REPO`. |
| `/color` | Everyone | Pick a curated color role. **Feature-flagged off** by default (`feature.color_roles`). |
| `/sudo` | Sudo | Admin panel: Settings, Manage user, Game Night, active channels, force owner transfer, hubs, force cleanup, pending approvals, run reconciler, restart instructions. |
| Right-click user → **Manage** | Sudo | Roles, voice status, disconnect, staff history, plus profile + game-prefs editors for the target. |

### Permissions

A self-service vs. sudo-on-behalf pattern runs throughout: members edit their own profile / birthday / game prefs via `/settings` and `/games`; sudo edits the same (plus staff fields) via right-click → **Manage** or `/sudo → Settings`. The `/sudo → Settings` surface is a runtime config editor for sudo users, channels, voice timings, hubs, auto-threads, games, user profiles, social feeds, channel archive, welcome/goodbye messages, auto-join roles, color roles, reaction roles, and feature flags (the **Debug** sub-panel — flag toggles and cache/orphan tools gate on bot-owner, not just sudo).

Required Discord bot permissions: **Manage Channels**, **Move Members**, **Manage Roles**, **View Channels / Send Messages / Read Message History**, **Use External Emojis** (Components V2). Privileged intents in the Developer Portal: **Server Members**, **Presence**, and **Message Content** (the last is required for auto-thread name templating).

### Voice control panel buttons

The control panel in each auto-channel text channel is the primary interaction surface (slash commands are fallbacks). Toggle buttons use the **status-flip convention** — the label shows the *current* state, not the pending action.

| Button | What it does |
|---|---|
| ✏️ **Rename** | Modal to set a custom name (also updates `fallback_name`) |
| 🔒 **Locked** / 🔓 **Unlocked** | Toggle `@everyone` Connect |
| 🙈 **Hidden** / 👁️ **Visible** | Toggle channel visibility |
| 👑 **Hosts** | Panel listing each member with their rank (👑 host · 🛡️ sudo · 👤 member); click to toggle host status |
| 📋 **Templates** | Auto / Counter `[x/y]` / Comp 5-stack / Tryhard / Chill — sets name + user limit in one click |
| 👤 **Claim** | Take ownership when the original owner has left |
| 🗑️ **Delete** | Delete both voice + text channels immediately |

## Deployment

Production runs on Docker. The image is built on GitHub Actions (the VPS has ~900 MB free RAM and cannot compile TypeScript) and published to GHCR; **watchtower** on the VPS polls the `:latest` tag and restarts the container when its digest changes. The CI workflow also SSHes in to `git reset --hard origin/main` and `docker compose up -d` as a belt-and-suspenders deploy.

A management CLI ships at `scripts/squishybot`. Install once:

```bash
sudo cp scripts/squishybot /usr/local/bin/squishybot
sudo chmod +x /usr/local/bin/squishybot
```

Then from anywhere (auto-detects the project dir):

```bash
squishybot start        # docker compose up -d (bot + db)
squishybot stop         # stop the stack (preserves volumes)
squishybot restart      # restart just the bot container
squishybot status       # docker compose ps
squishybot logs         # tail live logs (Ctrl+C to exit)
squishybot tail 50      # last 50 log lines
squishybot pull         # pull the latest image
squishybot update       # git pull + image pull + up -d
squishybot rebuild      # build image locally + restart
squishybot deploy       # register slash commands (uses .env)
squishybot db:shell     # psql into the postgres container
squishybot env          # edit .env and reload containers
```

First-time VPS setup, CI secrets, rollback, and Unraid notes live in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Conventions

- **CHANGELOG** — every PR adds a dated, real-semver section at the top of [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog format) with a `v<x.y.z> · <sha>` footer; `package.json` carries the matching version.
- **Project board** — every work unit gets an item on the [Bot Development project board](https://github.com/users/jason-tucker/projects/3).
- **Schema** — change `src/db/schema/*.ts` and let `drizzle-kit push` apply it; never hand-write SQL migrations. A schema push on `main` notifies botpanel to re-vendor the Drizzle schemas.
- See **[CLAUDE.md](CLAUDE.md)** for the full contributor playbook and the **[project wiki](https://github.com/jason-tucker/squishybot/wiki)** for deep-dive docs (architecture, auto-voice internals, bot-owner permissions, staff roles, database schema, environment variables, feature roadmap).
