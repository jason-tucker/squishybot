# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [0.6.0] — 2026-05-05

### Added
- Rich presence channel naming: detects Playing activity → "Tucker's Valorant (2/4)"; falls back to "Tucker's Channel"
- `GatewayIntentBits.GuildPresences` intent (enable in Dev Portal → Bot → Presence Intent)
- Discord presence service (`src/services/presence.ts`): Online on start, Idle after 15 min, DND on errors
- `/squishy` command — user-facing menu with bot info + staff request button
- `/sudo` — admin select-menu panel (sudo only)
- `/voice` — single command (no subcommands), opens ephemeral control panel
- Right-click context menu "Manage User" (sudo only): roles, voice status, disconnect, staff history
- `Claim` button on voice control panel (claim when owner has left)
- `src/services/logger.ts` — `attachClientToLogger()`, `dmOwner()`, `errorAndDm()`
- Startup DM to `BOT_OWNER_ID` on every bot start
- Docker Compose setup with multi-stage Dockerfile
- `drizzle-kit push` for schema management — no SQL migration files committed to git
- GitHub Actions CI/CD: build on runner, push to GHCR, SSH deploy
- `scripts/squishybot` management CLI (Docker-based): start/stop/restart/logs/tail/update/rebuild/deploy/env/db:shell
- `scripts/install.sh` — one-shot VPS installer
- `docs/DEPLOYMENT.md` — full deployment guide

### Changed
- Slash commands consolidated to 3: `/voice`, `/squishy`, `/sudo` + right-click context menu
- Removed `/help`, `/staff` (staff request moved to `/squishy` button), old `/squishy` subcommands
- Voice control panel: fixed `content: null` bug that prevented initial panel post in text channel
- All bot responses are ephemeral by default
- Schema management: switched from Drizzle SQL migrations to `drizzle-kit push`
- Production runtime: `node dist/index.js` (compiled) instead of `tsx src/index.ts`

---

## [0.4.0] — 2026-05-04

### Added
- `/help` command — Components V2 list of available commands; sudo section only shown to sudo users
- `/sudo` command suite — `channels`, `hubs`, `cleanup`, `approvals`, `restart`
- `/staff request` command — opens modal for category, department, tier, real name, reason
- Staff approval workflow: posts to `STAFF_APPROVAL_THREAD_ID` thread, pings
  `STAFF_APPROVAL_PING_USER_ID`, sudo Approve/Deny buttons edit message in place,
  requester gets DM with result
- Management CLI `scripts/squishybot` mirroring otterbot pattern (start/stop/restart/status/logs/tail/update/install/deploy/migrate)
- systemd units in `deploy/systemd/`: main service + Tuesday 4 AM weekly restart timer
- Weekly auto-restart timer

### Changed
- Renamed `BLIPS_CHANNEL_ID` → `CLIPS_CHANNEL_ID`
- Replaced `STAFF_APPROVAL_CHANNEL_ID` with `STAFF_APPROVAL_THREAD_ID` + `STAFF_APPROVAL_PING_USER_ID`

### Fixed
- Zod v4 `.default('')` on transform output — moved default into `commaSeparated` helper

---

## [0.3.0] — 2026-05-04

### Added
- `/squishy status` — Components V2 ephemeral with uptime, active channel count, hub count
- `/squishy repair` — sudo-only manual reconciler trigger
- `/voice panel` — re-posts or updates the control panel from any channel
- `/voice claim` — claim ownership of unclaimed auto channel
- `/voice delete` — owner/host/sudo shortcut to delete auto channel
- `voiceStateUpdate` event — hub join detection, member join/leave permission sync,
  ownership transfer when owner leaves, cleanup scheduling on empty channel
- `hubManager` — seeds hubs from env on startup, handles in-place hub rename + replacement creation
- `autoChannel` — creates auto channel pair (renames hub in place, creates text channel with
  permission overwrites), deletes channel pair and DB row
- `controlPanel` — posts/edits the Components V2 control panel; edits in place, reposts if missing
- `cleanupScheduler` — DB-backed cleanup timers that survive bot restarts
- `reconciler` — startup recovery: repairs orphaned channels, recreates missing hubs, re-posts panels,
  restores cleanup timers
- `permissions` — `isSudo`, `isOwner`, `isHost`, `canControlChannel`, `syncTextChannelPermissions`
- `voiceControl` button handler — delete+confirm, rename (modal), lock/unlock, add/remove host (select)
- `voiceControl` select handler — add_host, remove_host
- `voiceRename` modal handler — rename with sanitization
- Components V2 control panel embed with rename, lock/unlock, add/remove host, delete buttons
- Fixed env.ts empty string → `undefined` for all optional fields (prevents URL validation crash)

---

## [0.2.0] — 2026-05-04

### Added
- Extended `env.ts` with all required vars: `GUILD_ID`, `SUDO_ROLE_IDS`, `SUDO_USER_IDS`,
  `AUTO_VOICE_CATEGORY_ID`, `HUB_CHANNEL_IDS`, `VOICE_CLEANUP_DELAY_MS`, `LOG_CHANNEL_ID`,
  `ADMIN_CHANNEL_ID`, and future-feature optional vars
- Added `GatewayIntentBits.GuildVoiceStates` and `GuildMessages` to client intents
- Full database schema: `auto_channels`, `hub_channels`, `user_profiles`, `staff_approvals`,
  `games`, `user_game_prefs`
- Initial migration `0001_initial_schema.sql` — all tables created in PostgreSQL
- `.env.example` updated with all new variables documented
- `README.md` — full setup and usage guide
- `CLAUDE.md` — complete AI coding reference with services, customId conventions, env table

---

## [0.1.0] — 2026-05-04

### Added
- Initial project scaffold — Discord.js v14, TypeScript, PostgreSQL + Drizzle ORM
- Zod-validated environment config
- systemd-ready entry point with clientReady event
- Uptime Kuma push health monitor support
