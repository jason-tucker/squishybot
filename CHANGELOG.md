# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- **Staff request flow redesigned around the 7 linked staff roles.** "Request Staff Role" now opens an ephemeral picker listing the 7 staff roles (sourced from `STAFF_ROLE_DEFS`) instead of a free-text Category/Department/Tier modal. Picking a role opens a much smaller modal with just `real_name` and `reason` (both optional). Approval card shows the chosen **Role** plus optional name/reason, and on **Approve** the bot resolves the linked Discord role via `bot_settings` and grants it via `member.roles.add()`. The approval message + requester DM both echo the grant outcome (granted / already had it / role unlinked / Discord error). Legacy pending requests with the old free-text shape are still rendered in full but won't auto-grant — reviewer adds the role manually.
- **`/help` updated for today's voice + staff changes.** The "Voice Control Panel" section now describes the silent first message, the In-channel member list with join times + presence, the count-aware auto-rename (`(N) Game`), and the status-flip wording on **Locked / Unlocked** + **Hidden / Visible**. The "Staff Requests" section walks through the new picker → small modal → auto-grant flow.

### Added
- **`/sudo → Settings → Staff Roles`** — new sub-panel managing the 7 staff roles (Tier 1/2/3, Help Desk, Onsites, Security, Leadership). Per-slot status display (✅ linked / ⚠️ stale / 🔗 exists-but-unlinked / ❌ missing). One **Provision & link** button is idempotent: creates any missing Discord role (hoisted, no color, no perms), auto-links by name into `bot_settings` (`staff.role.tier_1`…`staff.role.leadership`), then bulk-positions the 7 roles directly above the highest game role. **Clear links** wipes the bot_settings keys without touching Discord. New button on the `/sudo → Settings` home panel.
- **`/sudo → Game Night`** — sudo schedules a Game Night via a modal (game name from the catalog, when, optional notes). Bot posts a Components V2 announcement **in the channel `/sudo` was run from** with three RSVP buttons (✅ Joining / 🤔 Might join / ❌ Not joining), two ownership buttons (👍 I own it / 🛒 I don't own it), and a ✖️ Cancel button (host or sudo). Body shows live counts + mention lists per category, including a 🛒 "Need a copy" list. State in-memory keyed by message ID with parse-from-message recovery so live announcements survive restarts.

### Changed
- **Toggle buttons now show current state, not the pending action.** Profile birthday-pings / year-visible toggles, voice channel Lock/Hide, and per-game View/Pings buttons now display the *current* state (e.g. `Birthday Pings: Enabled` green / `Birthday Pings: Disabled` red, `Locked` red / `Unlocked` green, `Pings: On` green / `Pings: Off` red). Clicking still toggles. Same convention should be applied to otterbot's portal toggles.
- **Voice sticky stripped down.** Drops the CV2 container + warning text; just a single non-CV2 silent message with an "Open Panel" button. Channel-deletion warning lives in the control-panel header instead.
- **Voice panel posted silently** — adds `SuppressNotifications` to the flag set so no notification fires when it's first posted to a fresh auto-channel.
- **Voice panel "In channel" list now includes each member's current rich-presence game** (e.g. `• @user joined <t:N:R> · 🎮 Overwatch`).
- **Auto-rename now picks the most-played game across all VC members and prefixes a count when more than one is playing it** (e.g. 3 of 4 members playing Overwatch → `(3) Overwatch`). Shared helper `services/voice/autoNaming.ts` used by `presenceUpdate`, the `Auto`/`Counter` template buttons, and the reconciler. `presenceUpdate` now keys off the changed user's voice channel rather than ownership, so a non-owner's game can flip the channel name.
- **`/sudo → Manage user → View Staff Record`** now has a Back button returning to the manage panel.

### Added
- **Auto-rename now reverts to a fallback name when nobody is playing anything.** New `auto_channels.fallback_name` column captures the channel's stable name: set on creation (initial random tech name) and on manual rename or Tryhard/Chill templates. Once everyone stops playing the auto-derived game, the channel renames back. Legacy rows without a fallback skip the revert until next manual rename.

### Fixed
- **New auto channels weren't getting a control panel posted.** `postOrUpdateControlPanel` was relying on `guild.channels.fetch()` immediately after `guild.channels.create()` — the bot's channel cache hadn't caught up, so the fetch returned a value that failed `.isTextBased()` and the function silently returned. Fixed by passing the freshly-created `TextChannel` object straight through from `createAutoChannel`. Added clearer warn-level logging on every silent-return path.

### Changed
- **Voice control panel rewritten to be compact + member-aware.** Drops the title block, accent-color sidebar, and instruction text. New layout: `🔊 host @owner · created <t:N:R>` plus an "👥 In channel" list with each member's relative join timestamp (`• @user joined <t:N:R>`). Stays the channel's first/top message; re-renders on every voice-state change so the member list and timestamps stay current. Sticky at the bottom is unchanged.

### Added
- **DB-backed voice-channel join times.** New `auto_channel_members(voice_channel_id, user_id, joined_at)` table backs the panel's member list. Written from `voiceStateUpdate` on join (upsert) and leave (delete). Reconciler backfills currently-occupying members at boot with `now()` so old times pre-restart are lost but new joins are tracked accurately.
- **Reconciler-driven auto-rename retry.** On every boot, for each tracked auto channel where the owner is currently in the channel and playing a game (and `auto_name_enabled` is on), the channel + text channel rename to match. Closes the gap where presence updates between bot restarts were lost.

### Fixed
- **Auto channels never auto-renamed by default.** Fresh auto channels are created with `auto_name_enabled=true, name_template=null` (schema defaults), but the `presenceUpdate` gate required `name_template === 'auto'` to fire — so the rename only worked after the user explicitly clicked `/voice → Templates → Auto`. Fixed by treating `null` template as equivalent to `'auto'` (default = just-the-game-name format).

### Changed
- **`/games` list display rewritten from markdown table to grouped lines.** The old `| Game | View | Pings | Interested |` table rendered cramped on Discord (especially mobile). Now games are split into **Your games** (any view or ping toggled on) and **Available**, one per line with the same `🟢 🔔` status emojis. Interest counts removed from the list view — they're still in the dropdown option descriptions where space is intentional.
- **`/play <game>` is now an LFG-with-join-button flow.** Drops `party_size` / `when` / `platform` / `rank` / `message` args — `/play` takes just `<game>`. The bot posts a Components V2 message in the game's channel, pings the configured ping role, and shows a "🎮 I want to play!" button. Anyone clicking the button toggles their presence in the player list (host can't toggle themselves out — they delete the message to cancel). State held in-memory keyed by message ID with parse-from-message recovery on cache miss (so existing posts survive bot restarts). `allowedMentions` still hardened so `@everyone`/`@here` can never resolve.
- **`/play` cooldown reduced 30 → 10 min** and the `force` arg dropped — sudo users automatically bypass the cooldown.
- **`/play` and `/sudo Game Night` posts both have a ✖️ Cancel button** clickable by the host (encoded in customId so it survives restarts) or any sudo user. Deletes the message; falls back to a "cancelled by @user" edit if delete fails.
- **Right-click context menu renamed `Manage User` → `Manage`.** Same panel, same buttons (Edit Profile, Game Prefs, View Channel Panel, Disconnect from Voice, View Staff Record). Also reachable via `/sudo → Manage user → pick a member` for sudo who don't want to right-click.
- **`/sudo` sub-panels now have a "🏠 Back to /sudo" button** — every panel reachable from the top-level select menu (Active voice channels, Hub channels, Force cleanup, Pending approvals, Run reconciler, Restart instructions) and the Settings home gets a one-click jump back to the original `/sudo` view instead of having to dismiss + rerun the command.
- **Right-click context menu renamed `Manage User` → `Manage`.** Same panel, same buttons (Edit Profile, Game Prefs, View Channel Panel, Disconnect from Voice, View Staff Record).
- **`/sudo` sub-panels now have a "🏠 Back to /sudo" button** — every panel reachable from the top-level select menu (Active voice channels, Hub channels, Force cleanup, Pending approvals, Run reconciler, Restart instructions) and the Settings home gets a one-click jump back to the original `/sudo` view instead of having to dismiss + rerun the command. New customId `sudo:home` with handler in `commands/sudo.ts` re-rendering the original menu.

### Added
- **`/sudo → Settings` panel** — runtime-editable bot config without redeploying. New `bot_settings` table (key/value, swept into an in-memory cache at boot) backs ChannelSelectMenu pickers for log/admin/birthday/staff-approval-thread channel IDs and a numeric editor for `voice.cleanup_delay_ms`. Each setting shows source (⚙️ DB override vs 📄 env) and has a Reset button to clear the override and fall back to env.
- **`/sudo → Settings → Sudo Users`** — grant sudo to any member via Discord's native UserSelectMenu, revoke via a select of current additions. Backed by a new `sudo_users` table; `isSudo()` consults env (immutable) + this DB-backed cache (mutable). `SUDO_USER_IDS` env-defined sudo users still cannot be removed at runtime.
- **`/sudo → Settings → Auto Threads`** — runtime-managed list of channels where every non-bot message gets a public thread. Backed by a new `auto_thread_channels` table (per-channel `name_template?`, `archive_duration?`). ChannelSelectMenu adds, StringSelectMenu removes; thread name defaults to `{author} — {first line}` (truncated to 100 chars). Replaces the earlier `feature.clips_auto_thread` / `feature.food_auto_thread` toggle pair, which only supported two hardcoded channels.
- **`MessageContent` privileged intent** added to the client — required for the auto-thread name template. Must also be enabled in the Discord Developer Portal → Bot.
- **`/sudo → Settings → Games`** and **`User Profiles`** stub panels — show counts from the existing `games` / `user_profiles` tables and link out for future feature implementation. Schemas already exist; the editors land here when those features ship.
- README link to the [Bot Development project board](https://github.com/users/jason-tucker/projects/3) — full roadmap, completed work, and open action items tracked there with `Tucker Action` and `Blocked` statuses.

- **`/sudo → Settings → Hub Channels`** — runtime-managed list of voice channels that act as auto-channel hubs. ChannelSelectMenu (voice only) adds; StringSelectMenu unregisters. Newly added hubs inherit the channel's current parent (or the auto-voice category override) and label. `HUB_CHANNEL_IDS` env is now optional — kept as a legacy seed list that runs once on boot when set, but the DB is authoritative going forward.
- **`channel.auto_voice_category` setting** — override the env-defined `AUTO_VOICE_CATEGORY_ID` from the Voice sub-panel without restarting. Wired through `autoChannel.ts`, `hubManager.ts`, and the reconciler so changes take effect on the next channel create.
- **In-memory hubs cache** — `loadSettings()` now also seeds a `hubsCache`, and `isHubChannel()` is a sync cache lookup instead of a per-event DB query. Hot path on every voice state update.
- **User profile editor** — accessible from three entry points, all backed by the same shared `profileEditor.ts` module:
  - `/sudo → Settings → User Profiles` — UserSelectMenu picker → editor with full sudo field set (display name, real name, birthday, staff fields, opt-outs).
  - **Right-click → Manage User → Edit Profile** — opens the editor for the targeted member directly. Sudo only.
  - `/profile` — self-service. Members can edit their own display name, birthday, and the two birthday flags (`birthday_pings_enabled`, `birthday_year_visible`). Staff fields stay sudo-only.
  - All edits go through `services/userProfile.ts` with sudo-vs-self field gating; every mutation logs a `profile-edit` line with editor + target + mode + fields touched.
- **`user_profiles` schema** — new boolean columns `birthday_pings_enabled` (default `true`) and `birthday_year_visible` (default `false`).
- **Birthday pings** — daily scheduler that fires once per day at the configured target hour (`birthday.target_hour`, default 9) and posts a celebratory message in `channel.birthday` for every member whose birthday is today and who hasn't opted out. Same-day restarts are idempotent via `bot_settings` key `birthday.last_run_date`. Feb 29 birthdays get celebrated on Feb 28 in non-leap years.
- **Game roles + game prefs + `/play` LFG**:
  - **`/sudo → Settings → Games`** — full catalog editor. Add a game (modal: name + aliases + sort order), then on the detail panel set the View role + Ping role via RoleSelectMenu, edit name/aliases/sort via modal, toggle visibility/archive, or delete. In-memory catalog cache loaded by `loadGames()` on startup.
  - **`/games`** — self-service. Members see every visible+non-archived game with View / Pings toggles. Toggling immediately adds or removes the corresponding Discord role on the member.
  - **Right-click → Manage User → Game Prefs** — sudo opens the same prefs editor in `mode='sudo'` and edits roles on behalf of the targeted member. Same module, same UI, just keyed to a different target.
  - **`/play <game>`** — LFG ping. Autocompletes on game name + aliases. Resolves channel + ping role from the catalog, enforces a 30-minute per-(user, game) cooldown (in-memory; sudo can `force:true` to bypass). Strips raw role/user/channel mentions from user input and sets `allowedMentions` so `@everyone`/`@here` are never resolved regardless of arguments.

### Removed
- The static `feature.clips_auto_thread` / `feature.food_auto_thread` toggles and their `channel.clips` / `channel.food` channel-pickers. Auto-thread channels are now data, not code — managed via the new `Auto Threads` sub-panel. The corresponding env vars (`CLIPS_CHANNEL_ID`, `FOOD_CHANNEL_ID`) are unused; safe to drop from `.env`.
- The `Features` button on the `/sudo → Settings` home — the only flags it housed were the two auto-thread toggles. The infrastructure (`BOOLEAN_SETTINGS`, `effectiveBoolValue`, `renderFeatures`, `sudo:set:toggle:{key}` handler) is gone; reintroduce when a future flag actually needs a toggle.

### Changed
- `cleanupScheduler` now reads `voice.cleanup_delay_ms` from the runtime settings cache before falling back to the env value.
- `/help` rewritten to reflect the actual command surface — removed listings for non-existent subcommands (`/squishy status`, `/voice panel/claim/delete`, `/squishy repair`, `/sudo channels/hubs/cleanup/approvals/restart`); the sudo section now describes the `/sudo` select menu and its Settings sub-panel.
- README — `/sudo` row in the slash-commands table now describes the full menu surface; new "Sudo Panel" feature section explains runtime config overrides; removed "Sudo user management panel" from Planned Features (it shipped) and noted that the auto-thread feature flag is already wired even though the auto-thread behavior itself isn't built yet.
- Internal: extracted shared Components V2 `sep()` helper to `src/utils/cv2.ts` and replaced inline `SeparatorBuilder` constructions across 10 files. No behavior change.
- Internal: extracted `requireControl()` helper in `src/interactions/buttons/voiceControl.ts` to deduplicate the 7-action permission-check + ephemeral-error pattern. No behavior change.

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
