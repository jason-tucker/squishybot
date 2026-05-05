# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- README link to the [Bot Development project board](https://github.com/users/jason-tucker/projects/3) — full roadmap, completed work, and open action items tracked there with `Tucker Action` and `Blocked` statuses.

### Changed
- Internal: extracted shared Components V2 `sep()` helper to `src/utils/cv2.ts` and replaced inline `SeparatorBuilder` constructions across 10 files. No behavior change.

---

## [0.7.0] — 2026-05-05

### Added
- `/report` slash command — opens a modal (Title / Type / Description / Steps to reproduce); on submit, the bot DMs the owner (`BOT_OWNER_ID`) with the full content and four review buttons: ✅ Approve + Notify, ✅ Approve Silent, ❌ Reject + Notify, ❌ Reject Silent. Approve files a GitHub issue to `GITHUB_REPO` via the GitHub REST API.
- Silent sticky button at the bottom of every auto-channel text channel — single "📋 Open Panel" button + a `-#` subtext warning that the channel is temporary; re-posted at the bottom whenever a new message lands, with `MessageFlags.SuppressNotifications` so it never pings.
- Templates feature — `📋 Templates` button on the voice control panel opens an ephemeral picker with Auto / Counter / Competitive 5-stack / Tryhard / Chill. Auto follows your rich presence; Counter shows live `[x/y]` member count.
- Random tech default channel names — when no game is detected, channels get names like "Sloppy Ethernet" / "Yelling Switch" / "Happy DNS" instead of "User's Channel".
- New env vars: `GITHUB_TOKEN`, `GITHUB_REPO` (both optional — `/report` no-ops with a friendly error if unset).
- New schema column `auto_channels.sticky_msg_id` (nullable) to track the sticky message ID for re-post-on-message.
- New schema column `auto_channels.name_template` (nullable) to track which template a channel is using.
- `messageCreate` event handler with 1.5 s per-channel debounce — re-posts the sticky when a user messages in an auto text channel.
- `presenceUpdate` event handler is now actually registered (previously orphaned in source).

### Changed
- Lock / Unlock and Claim buttons now use `interaction.update()` so the clicked panel always reflects the new state, even if there are duplicate panel messages.
- Reconciler now sweeps stale bot messages in auto-channel text channels (preserving the tracked panel + sticky) so duplicates don't accumulate across restarts.
- `seedHubsFromEnv` skips registering a `HUB_CHANNEL_IDS` entry when that channel is already an active auto channel — prevents the corrupt-hub-row pattern that caused a fresh duplicate channel on every boot.
- Reconciler hub recreation now checks the category for an existing channel matching the stale hub's label before recreating; if found, the corrupt row is deleted instead.
- Default channel name dropped the `displayName's` prefix — a Playing activity yields just the game name, otherwise a random tech name.

### Fixed
- `delete_confirm` no longer crashes with `DiscordAPIError[10008] Unknown Message` when the auto channel was deleted faster than `editReply` could resolve — switched to `deferReply({ ephemeral: true })` so the confirmation lives in a separate ephemeral message.
- Templates select-menu interactions previously routed to the wrong handler (`handleVoiceControlSelect`) and silently failed; routing now matches `:template_apply` first.
- Templates popup crashed with `COMPONENT_CUSTOM_ID_DUPLICATED` when both select menus shared a customId.
- CI deploy step `node dist/bot/registerCommands.js` now overrides the Docker `ENTRYPOINT` so it doesn't run `drizzle-kit push` against a placeholder DB.

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
