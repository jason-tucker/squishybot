# SquishyBot — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, systemd setup,
Discord.js patterns, Components V2, and database conventions that apply to all bots.

---

## Agent usage

Always spawn agents to do work. Haiku for lookups. Sonnet for coding. Opus for planning.

Use agents proactively — delegation is the default, not a fallback. Match the model to the task:

- **Haiku** — file discovery, repository searches, quick lookups, lightweight analysis, and simple verification.
- **Sonnet** — coding, implementation, refactoring, debugging, writing tests, editing documentation, and normal technical work.
- **Opus** — architecture, complex planning, cross-repository strategy, high-risk changes, difficult debugging strategy, and final reconciliation.

How to delegate well:

- Run independent work in parallel; serialize only when there is a real dependency.
- Give every delegated task a precise scope and a concrete expected output.
- Require every agent to cite the paths, symbols, commands, or repository evidence behind its conclusions.
- Demand actionable results, not generic summaries.
- Never let two agents edit the same file at once — assign explicit file ownership and coordinate overlaps through the orchestrator.
- Resolve conflicting recommendations with repository evidence, not preference.
- Validate every agent's output before accepting it; re-run or re-scope on doubt.
- Use agents to improve speed or quality — not to create pointless duplication.
- The orchestrator reviews all delegated work and remains responsible for final correctness.

`/home/botuser/projects/claude-all.md` (referenced above) is a VPS-side file NOT present in this repo — agents cannot read it. Key inlined constraints: never run `pnpm typecheck`/`tsc`/`pnpm build` on the VPS (they OOM it — run typecheck locally before pushing); never `drizzle-kit push` in production (the container runs committed migrations).

---

## Convention: every per-user setting must be sudo-editable on behalf of users

The user community for this bot is mostly non-technical. **Most members will not edit their own bot settings**, so any per-user setting added here must be reachable from two surfaces:

1. A self-service entry point (`/profile`, `/games`, etc.) — `mode='self'`, target is the caller, restricted field set.
2. A sudo entry point — `/sudo → Settings → <feature>` AND a button on right-click → **Manage User**. Same shared editor module, `mode='sudo'`, target is whichever member sudo picked, full field set.

The shared-editor pattern is established in:

- `src/interactions/profileEditor.ts` — `renderProfileEditor(guildId, targetUserId, displayName, mode)` + customId family `profile:*` keying mode + target.
- `src/interactions/gamesEditor.ts` — `renderPrefsEditor(guild, targetUserId, mode)` + customId family `games:prefs:*`.

When you add a new per-user feature, follow the pattern. Don't ship a self-service command without the sudo path, and don't ship a sudo path without the self-service entry point.

The Manage User context menu (`src/commands/manageUser.ts`) is the canonical landing pad for sudo-acts-on-behalf flows — add a new button there for every new per-user surface.

**Avoid command bloat for self-service entry points.** Don't register a top-level slash command for every per-user feature — push them through `/settings`' panel-with-buttons UX instead. Profile editing is reachable via the **Profile & Birthday** button on `/settings`, not a `/profile` command. Reserve top-level slash commands for high-frequency or high-value flows (`/games`, `/play`, `/voice`, `/report`).

---

## What this bot does

SquishyBot is a multipurpose Discord bot for a single server. Its core feature is **dynamic
auto voice channels** with attached text channels, per-channel permission controls, and a
persistent interactive control panel. Future features include staff role workflows, game
role/channel management, birthday pings, user profile management, and automatic thread
creation.

### Auto voice channels

- One or more **hub** voice channels act as entry points
- When a user joins a hub, the hub is **renamed in place** into their auto channel (user stays)
- A replacement hub is immediately created in the same category
- An attached **text channel** is created in the same category, directly below the voice channel
- Only users currently in the voice channel, the owner/hosts, and sudo users can see the text channel
- A **control panel message** (Components V2) is posted in the text channel with interactive buttons
- When the voice channel becomes empty, both channels are deleted after a configurable delay
- On bot restart, a reconciler repairs orphaned channels and missing hubs

---

## Commands

Eight slash commands are registered plus one right-click context menu (verified in `src/bot/registerCommands.ts`).

| Command | Description | Permission |
|---|---|---|
| `/voice` | Open an ephemeral copy of the control panel for the channel you're currently in | Owner/Host/Sudo |
| `/help` | User-facing menu: bot status + feature explainers (Voice / Panel / Games / Game Night / Staff / Reports). Self-service edits live under `/settings`. | Everyone |
| `/settings` | Self-service: Profile & Birthday, Game Prefs, Staff Role (request / remove on self). | Everyone |
| `/sudo` | Admin select-menu panel: Settings, Manage user (pick), Game Night (schedule), Active VCs, Hubs, Force cleanup, Pending approvals, Run reconciler, Restart instructions. Sub-panels have 🏠 Back to /sudo. | Sudo |
| `/report` | Open a modal to file a GitHub issue (Title / Type / Description / Steps); owner approves via DM before it lands on GitHub | Everyone |
| `/games` | Pick which games you want View / LFG-ping roles for | Everyone |
| `/play <game>` | Post a CV2 LFG message in the game's channel with a "🎮 I want to play!" toggle button. 30-min per-(user,game) cooldown. State in-memory + parse-from-message fallback. | Everyone |
| `/color` | Pick a curated color role. **Feature-flagged off** by default (`feature.color_roles`). | Everyone |
| Right-click user → **Manage** | Edit Profile, Game Prefs, voice status, disconnect, staff history | Sudo |

**Note:** `/gamenight` is not a registered slash command — game night scheduling is reached via `/sudo → Game Night`. The `src/commands/gamenight.ts` module provides interaction handlers only (modal submit + RSVP buttons), all under the `gn:` customId family.

The persistent control panel (in each auto-channel text channel) is the primary
interaction surface. A silent sticky message at the bottom of every auto-channel
text channel keeps a quick `📋 Open Panel` button visible no matter how much
chat scrolls; clicking it gives you an ephemeral copy of the panel.

### Voice control panel buttons

| Button | What it does |
|---|---|
| ✏️ **Rename** | Modal to set a custom name |
| 🔒 **Locked** / 🔓 **Unlocked** | Toggle Connect permission on `@everyone` (label shows current state) |
| 🙈 **Hidden** / 👁️ **Visible** | Toggle `ViewChannel` on `@everyone` (label shows current state) |
| 👑 **Hosts** | One panel listing each member with their current rank emoji (👑 host · 🛡️ sudo · 👤 member). Clicking toggles host status. |
| 📋 **Templates** | Naming-only. Auto (default `(N) Game`) / Counter `Game [N]` / Squad `Game · N squad` / Detail `Game — {details}` / State `Game — {state}` / Party `Game (X/Y party)` / Stealth (bare) / Chill (fixed `{member}'s Chill Session`, disables auto-rename). **No template ever touches user limit** — set it in Discord's channel settings if you want one. |
| 👤 **Claim** | Take ownership when the owner has left |
| 🗑️ **Delete** | Delete the voice + text channels right away |

## Terminal management

`scripts/squishybot` is the management CLI (Docker-based). Install once with
`sudo cp scripts/squishybot /usr/local/bin/squishybot && sudo chmod +x /usr/local/bin/squishybot`,
then use (run `squishybot` with no args for the full list):

| Command | Action |
|---|---|
| `squishybot start` | `docker compose up -d` (bot + db) |
| `squishybot stop` | Stop the stack (preserves volumes) |
| `squishybot restart` | Restart just the bot container |
| `squishybot down` | Stop and remove containers (preserves volumes) |
| `squishybot status` / `ps` | `docker compose ps` |
| `squishybot logs` | Tail live logs |
| `squishybot tail [N]` | Last N log lines (default 30) |
| `squishybot pull` | Pull latest image from registry |
| `squishybot update` | git pull + image pull + `up -d` |
| `squishybot build` | Build image locally |
| `squishybot rebuild` | `up -d --build` (rebuild and restart) |
| `squishybot deploy` | Register slash commands (uses .env values) |
| `squishybot shell` / `exec` | Open a shell inside the bot container |
| `squishybot db:shell` / `psql` | Open psql inside the postgres container |
| `squishybot env` | Edit .env and reload containers |
| `squishybot where` | Print the auto-detected project directory |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NODE_ENV` | No | `development` or `production` |
| `GUILD_ID` | Yes | The single guild this bot serves |
| `SUDO_ROLE_IDS` | No | Comma-separated role IDs with bot-admin powers |
| `SUDO_USER_IDS` | No | Comma-separated user IDs with bot-admin powers |
| `AUTO_VOICE_CATEGORY_ID` | Yes | Default Discord category for hubs and auto channels. Overridable at runtime via `/sudo → Settings → Voice → Auto-voice category` (`channel.auto_voice_category` key in `bot_settings`). |
| `HUB_CHANNEL_IDS` | No | Legacy seed list of hub voice channel IDs. Authoritative source is now the `hub_channels` table; manage via `/sudo → Settings → Hub Channels`. Env is only consulted on boot to seed any IDs not yet in DB. |
| `VOICE_CLEANUP_DELAY_MS` | No | ms before empty channel cleanup (default: 30000) |
| `LOG_CHANNEL_ID` | No | Bot posts structured log messages here |
| `ADMIN_CHANNEL_ID` | No | Sudo-only bot admin channel |
| `STAFF_APPROVAL_THREAD_ID` | No | Thread where `/staff request` posts go |
| `STAFF_APPROVAL_PING_USER_ID` | No | User pinged on each staff request |
| `BIRTHDAY_CHANNEL_ID` | No | Future: birthday ping channel |
| `CLIPS_CHANNEL_ID` | — | **Deprecated.** Auto-thread channels are now managed via `/sudo → Settings → Auto Threads` (DB-backed `auto_thread_channels` table). |
| `FOOD_CHANNEL_ID` | — | **Deprecated.** Same as above. |
| `UPTIME_KUMA_PUSH_URL` | No | Push monitor URL |
| `BOT_OWNER_ID` | No (Yes for `/report`) | Receives DM on every `/report` for review approval, plus startup DMs |
| `GITHUB_TOKEN` | No | Fine-grained PAT with `Issues: Read & Write` on `GITHUB_REPO`; required for `/report` |
| `GITHUB_REPO` | No | `owner/name` of the repo issues land in (e.g. `jason-tucker/squishybot`); required for `/report` |
| `REDIS_URL` | No | Redis connection URL for the event + command bus. Set automatically by Docker Compose (`redis://redis:6379`). Unset → event bus and RPC disabled, bot still runs. |
| `BOTPANEL_RPC_SECRET` | No | Shared HMAC secret with botpanel for the Redis command/cache bus. Unset → RPC + cache-invalidate subscribers disabled. |
| `PANEL_BASE_URL` | No | Base URL of the botpanel website for the "do this on the website" links appended to slash command replies. Defaults to `https://bots.tucker.host`. |
| `BOT_IMAGE` | No | GHCR image for `docker compose pull` (default `ghcr.io/jason-tucker/squishybot:latest`). Set by CI. |
| `POSTGRES_PASSWORD` | No | Postgres password for the Compose-managed DB. Use alphanumeric/hex (avoid `#`, `*`, `?`). |

---

## Database schema

| Table | Purpose |
|---|---|
| `auto_channels` | Tracks active auto voice channels and their state |
| `auto_channel_members` | Per-channel join times (`voice_channel_id, user_id, joined_at`) — drives the panel's "In channel" list with `<t:N:R>` timestamps |
| `hub_channels` | Registry of managed hub voice channels |
| `bot_settings` | Runtime key/value config overrides edited via `/sudo → Settings` |
| `sudo_users` | Members granted sudo at runtime (beyond the immutable `SUDO_USER_IDS` env list) |
| `auto_thread_channels` | Channels where every non-bot message gets an auto-thread (managed via `/sudo → Settings → Auto Threads`) |
| `social_feeds` | RSS-driven social feeds the poller reposts into a Discord channel. Managed via `/sudo → Settings → Socials`. Polled every 30 min (override via `bot_settings.social.poll_interval_ms`). Dedup keyed by RSS `<guid>` stored in `last_seen_id`; first poll seeds without posting so backlog isn't replayed. |
| `user_profiles` | User display names, birthdays (with opt-out flags), staff fields (sudo-edits any field; `/profile` self-edits a subset) |
| `staff_approvals` | Pending staff role approval queue |

### Staff role mapping

The 9 staff roles are stored as `bot_settings` keys (`staff.role.<slug>`) mapping role name → Discord role ID. The canonical registry (key, customId slug, label, Discord role name, category) lives in `src/services/staffRoles.ts` — both `sudoSettings.ts` and `commands/staff.ts` import from there.

Roles are split across three categories:
- **Tiers** (3): Tier 1 / Tier 2 / Tier 3 — seniority hierarchy.
- **Departments** (5): Help Desk / Onsites / Security / Sales / Leadership.
- **Base** (1): ITSRI Staff (`itsri_staff`) — auto-granted on every approval so anyone marked staff carries the umbrella role.

Manage via `/sudo → Settings → Staff Roles`:

- **Provision & link** — idempotent: creates any missing Discord role (hoisted, no color, no perms), links by name into `bot_settings`, then bumps the 9 roles' positions to one above the highest game role's position.
- **Clear links** — removes the linked IDs from `bot_settings` (Discord roles untouched).

### Staff request flow

The "Request a Staff Role" button (on `/settings → Staff Role`) goes through a two-step picker → modal flow:

1. **`open_staff_request`** button → ephemeral CV2 message with two selects (department and tier, both optional) and a disabled **Continue →** button.
2. **`staff:dept_pick:{tier_so_far}`** select → user picks a department (or clears it); the same message is updated with the selection locked in. Carries the current tier slug in the customId so neither axis is lost across round-trips.
3. **`staff:tier_pick:{dept_so_far}`** select → symmetric: user picks a tier (or clears it); message updated.
4. **`staff:request_open:{dept_or_none}:{tier_or_none}`** button (Submit) → opens a one-field modal for an optional real/preferred name. At least one axis must be non-none for the button to be enabled.
5. **`staff:request:{dept_or_none}:{tier_or_none}`** modal submit → inserts a `staff_approvals` row, posts the approval card in the staff approvals thread.
6. **`staff:approve:{id}`** / **`staff:deny:{id}`** buttons → on approve, grants the requested department role (if any), the requested tier role (if any), and always the base ITSRI Staff role. Outcome is appended to the approval card and DM'd to the requester.

**Legacy handler:** `staff:role_pick` (single-pick select from the old one-step flow) is still routed in `interactionCreate.ts` to handle older in-flight messages, but the new picker replaces it for all new requests.
| `games` | Game definitions — role ID, channel ID, ping role, sort order, aliases, per-game play-cooldown, auto-archive days |
| `user_game_prefs` | Per-user game view/ping preferences (View role opt-in + LFG ping opt-in per game) |
| `setting_changes` | Audit trail for `bot_settings` edits (key, old/new value, actor, timestamp) |
| `report_log` | Append-only log of every `/report` submission (status, GitHub issue URL, decision actor) |
| `reaction_role_messages` | Discord messages the bot watches for reaction-role events; optional `expires_at` for temporary (game-night) mode |
| `reaction_role_mappings` | Per-message (emoji → role ID) pairs for the reaction-role system |
| `scheduled_posts` | Generic scheduled/on-demand CV2 posts (`kind` discriminator; first consumer: `game_night`). Carries portable `spec` JSON, `variables`, `fire_at`, status, persisted RSVP/ownership maps. |
| `auto_join_roles` | Roles auto-granted to every new member on `guildMemberAdd`. Feature-flagged (`feature.auto_role_on_join`, default OFF). |
| `color_roles` | Curated list of color-only roles for `/color`. Feature-flagged (`feature.color_roles`, default OFF). |
| `archive_eligible_categories` | Discord categories opted into the channel-archive workflow via `/sudo → Archive` |
| `archived_channels` | Channels currently in the archived state (original name + category + timestamp for unarchive) |

---

## customId conventions

All voice control interactions use: `vc:{voiceChannelId}:{action}`

Actions: `delete`, `delete_confirm`, `rename`, `rename_submit`, `lock`, `unlock`, `hide`, `show`, `hosts` (button + select), `claim`, `templates`, `template_apply` (select), `open_panel` (sticky button)

`/report` uses three customIds (no vc prefix):
- `report:submit` — modal submission
- `report_approve_notice:{sessionKey}` / `report_approve_silent:{sessionKey}` — file the issue (with/without DMing reporter)
- `report_reject_notice:{sessionKey}` / `report_reject_silent:{sessionKey}` — drop the session (with/without DMing reporter)

Staff requests use:
- `open_staff_request` — entry-point button (on `/settings → Staff Role`)
- `staff:dept_pick:{tier_so_far}` — department string-select; carries the current tier slug in the customId
- `staff:tier_pick:{dept_so_far}` — tier string-select; carries the current dept slug in the customId
- `staff:request_open:{dept_or_none}:{tier_or_none}` — Submit / Continue button; opens the real-name modal
- `staff:request:{dept_or_none}:{tier_or_none}` — modal submission (current two-axis format)
- `staff:approve:{approvalId}` / `staff:deny:{approvalId}` — review buttons in the approval thread
- `staff:role_pick` — **legacy** single-pick select (older in-flight messages only; new flow uses the two-axis picker above)

Other customId families:
- `gn:*` — game night: `gn:setup_submit[:{sessionKey}]` (modal), `gn:preview:{send|edit|cancel}:{key}`, `gn:rsvp:{state}`, `gn:own:{state}`, `gn:cancel:{hostId}`
- `sp:*` — scheduled posts (DB-backed): `sp:rsvp:{postId}:{state}`, `sp:own:{postId}:{state}`, `sp:cancel:{postId}`
- `games:prefs:*` — game preferences editor: `games:prefs:set:`, `games:prefs:list:`, `games:prefs:back:`, `games:prefs:pick:`
- `games:cat:*` — game catalog management (sudo): `games:cat:select`, `games:cat:channel:`, `games:cat:role:`, `games:cat:add_submit`, `games:cat:save:`, `games:cat:set_category`
- `games:mass:*` — all-games single-user bulk prefs editor (self + sudo): `games:mass:open:{mode}:{uid}` (button → open), `games:mass:view:{mode}:{uid}` / `games:mass:ping:{mode}:{uid}` (multi-selects → apply diff)
- `games:defaults:*` / `games:bulk:*` — Game Defaults panel (sudo, `/sudo → Settings → Game Defaults`): `games:defaults:toggle:{on|off}` (flip `games.default_view_on` + backfill), `games:bulk:select` (pick a game), `games:bulk:{show|hide|clearpings}:{gid}` (server-wide per-game apply). The `games.default_view_on` setting (default OFF) switches game-channel View between opt-in (hidden, per-member allow) and opt-out (visible to @everyone, per-member deny). Pings stay opt-in regardless.
- `profile:*` — profile editor: `profile:edit:`, `profile:toggle:`, `profile:back:`, `profile:save:`, `profile:select_user`
- `settings:staff_role:*` — staff-role self-service in `/settings`: `settings:staff_role`, `settings:staff_role:add:`, `settings:staff_role:remove:`
- `color:pick` — color role string-select
- `play:*` — LFG ping interactions: `play:join:`, `play:cancel:`, `play:help:`, `play:notify:`

---

## Key services

| File | Role |
|---|---|
| `src/services/voice/hubManager.ts` | Hub detection, in-place rename, replacement hub creation |
| `src/services/voice/autoChannel.ts` | Create/delete auto channel pair, manage permission overwrites |
| `src/services/voice/controlPanel.ts` | Post and update the Components V2 control panel message |
| `src/services/voice/cleanupScheduler.ts` | DB-backed cleanup timers for empty channels |
| `src/services/voice/reconciler.ts` | Startup recovery: orphan cleanup, hub recreation, panel repair |
| `src/services/voice/permissions.ts` | `isSudo`, `isOwner`, `isHost`, `updateTextPermissions` |
| `src/services/voice/autoNaming.ts` | Rich-presence-driven auto-rename, channel name decoration (trailing emoji dedup) |
| `src/services/logger.ts` | Structured logging to console + optional LOG_CHANNEL_ID |
| `src/services/rpc/registry.ts` | Redis command-bus RPC server — HMAC-verifies incoming `cmd.squishy.*` messages and dispatches to handlers under `src/services/rpc/handlers/` |
| `src/services/eventBus.ts` | Redis fan-out event publisher — `bot.squishy.*` events (ready, heartbeat, voice, member) |
| `src/services/cacheInvalidator.ts` | Subscribes to `cmd.squishy.cache.invalidate` and refreshes in-memory caches (bot settings, reaction roles, etc.) |
| `src/services/scheduledPosts/` | `scheduler.ts` (15s tick, status-claim), `gameNight.ts` (RSVP/ownership context builder), `service.ts` (post/cancel helpers) |
| `src/services/msgspec/` | Portable MessageSpec JSON renderer — `render.ts` converts spec JSON to discord.js CV2 builders with `{{variable}}` substitution and `<t:UNIX:style>` timestamp support |

---

## Bot restart (production)

Production runs under Docker (GHCR image + watchtower). Use the management CLI or docker compose directly:

```bash
squishybot restart
# or:
docker compose restart squishybot
docker compose ps squishybot
```

## Deploy slash commands

```bash
pnpm deploy:commands
```

## Run database migrations

The container applies **committed SQL migrations on startup** (drizzle-orm migrate
runner: `scripts/docker-entrypoint.sh` → `node dist/db/migrate.js`). It is
forward-only and fails closed — a bad migration aborts startup instead of
silently mutating data. To run migrations manually against a DB:

```bash
pnpm db:migrate
```

### Changing the schema

`src/db/schema/*.ts` is the source of truth. To change it:

1. Edit the schema module(s).
2. `pnpm db:generate` — emits a reviewed SQL file under `src/db/migrations/` (+ snapshot/journal).
3. **Inspect the generated `.sql`** (especially any `DROP`), then commit it *with* the schema change. Migrations are committed — they are not gitignored.
4. On deploy, the startup runner applies it. The deploy workflow takes a `pg_dump` backup first, so every migration is recoverable.

`drizzle-kit push` is for throwaway local DBs only — **never in production**; the container migrates, it no longer pushes. The first migrate run against the pre-existing (push-built) production DB self-baselines automatically — see `security-review/H5_MIGRATION_CUTOVER.md`.

---

## Bot ↔ Botpanel integration

The bot exposes most flows as RPC verbs over a Redis command bus:

- **Commands from panel** → `cmd.squishy.<verb>` — panel publishes, bot subscribes via `src/services/rpc/registry.ts`. HMAC-signed with `BOTPANEL_RPC_SECRET` (`HMAC-SHA256(secret, "${channel}|${requestId}|${ts}|${JSON.stringify(params)}")`). Reply goes to `res.<requestId>`.
- **Events from bot** → `bot.squishy.*` — bot publishes via `src/services/eventBus.ts`; panel subscribes.
- **Cache invalidation** → `cmd.squishy.cache.invalidate` — panel triggers; `src/services/cacheInvalidator.ts` refreshes in-memory caches.
- **Schema sync** → when a push to `main` touches `src/db/schema/**`, `.github/workflows/notify-panel-schema-change.yml` fires a `repository_dispatch` at `jason-tucker/botpanel` so the panel re-vendors the Drizzle schemas automatically.

RPC verb handlers live under `src/services/rpc/handlers/` (organized by domain: `voice/`, `games/`, `staff/`, `scheduledPosts/`, `rxnroles/`, `admin/`, `discord/`, `hubs/`, and top-level verbs).

Both `REDIS_URL` and `BOTPANEL_RPC_SECRET` are optional — with either unset the bot runs standalone with no RPC or event bus.

---

## Local dev

```bash
pnpm install
cp .env.example .env   # fill in DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, etc.
docker compose up -d db
pnpm dev               # tsx watch — hot reload
```

Type-check **locally** (never on the VPS):

```bash
pnpm typecheck
```

There is no test framework. Verification is done by running the bot locally or in CI.
