# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
