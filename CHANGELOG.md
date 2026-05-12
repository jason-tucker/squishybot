# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- **`/report` is locked for Discord accounts younger than 6 months (#17).** Common throwaway-account spam mitigation. Computes `createdAt + 6 months`, and if that's still in the future, replies ephemerally with the exact unlock time as a relative timestamp: _"Your Discord account is too new to file reports. /report unlocks for accounts older than 6 months — yours unlocks `<t:N:R>`."_ Sudo isn't bypass-special — they can request normally via the staff-request flow if their account is new enough.
- **`/sudo → Settings → Archive` — in-depth manual channel-archive workflow (#15).** Manual, sudo-driven, opt-in safety model:
  - **Opt-in categories.** Nothing is scannable unless its parent category is explicitly opt-in via the Archive panel. Auto-channel text channels, hub voice channels, and already-archived channels are unconditionally excluded.
  - **Configurable destination + threshold.** `channel.archive_destination` (the category to move channels into) and `archive.stale_days` (default 90, range 1–3650). Threshold edits via modal.
  - **Scan-then-pick flow.** "Scan stale channels" returns a multi-select list with each channel's last-message timestamp (`<t:N:R>`). Sudo multi-picks which to archive. Per-channel failures are surfaced in an ephemeral followup; successes get summarized.
  - **Archive mechanics.** Move to destination category, prepend 🗄️ to the name, deny `@everyone` on Send / AddReactions / Create*Threads / SendMessagesInThreads. View stays open so history is readable. DB row is written before the Discord edit, so a crash mid-archive doesn't strand the channel (and is rolled back on edit failure).
  - **Unarchive.** "Unarchive a channel…" select restores the original name, parent category, and clears all Send-related denials. DB row is removed only after the Discord edits succeed.
  - New tables `archive_eligible_categories` and `archived_channels`. New service `src/services/archive.ts`.
- **`/sudo → Force owner transfer` — manually reassign owner of an auto-channel (#14).** Sudo two-step flow: pick channel → pick new owner. Bypasses claim, grace, and ownership rules. Cancels any active grace window (we're overriding it, not respecting it). New owner is removed from `host_user_ids` if they were a host. Permissions on the attached text channel are re-synced via `syncTextChannelPermissions` so the new owner picks up the right overwrite immediately. New customIds: `sudo:force_owner:channel_pick` (StringSelect), `sudo:force_owner:user_pick:{channelId}` (UserSelect). Logged as `Force owner transfer: vc=... A → B (by sudo X)`.
- **Dynamic `isBotOwner()` from the Discord Application Team (#11).** Bot-owner permission checks no longer depend on a single hardcoded `BOT_OWNER_ID` — the new `src/services/botOwner.ts` resolves owner status at runtime by reading `client.application.owner` (when the bot belongs to a Team on the dev portal). Team Admins + Developers count; Read-only members do not. `BOT_OWNER_ID` env stays as a fallback so the bot keeps working before a Team is set up. Resolved IDs are cached for 60 s; the cache is pre-warmed on READY and the resolved set is logged so misconfiguration is obvious. /report approval buttons now gate via `isBotOwner(client, userId)` instead of an env equality check, so any team Admin/Dev can approve.
- **Per-hub auto-channel defaults — template, manual name, user limit (#12).** Each hub voice channel can pin three optional defaults that apply to every auto-channel spawned from it. `default_template_key` drives the new auto-channel's naming template (one of `auto` / `counter` / `squad` / `detail` / `state` / `party` / `stealth`). `default_manual_name` is a literal name override supporting the `{member}` token; when set, `autoNameEnabled` is flipped off so presence-driven renames don't churn the pinned name. `default_user_limit` (0–99) is applied directly to the Discord voice channel on rename. Any field null = the bot's built-in default. UI: `/sudo → Settings → Hub Channels → "Edit defaults for a hub…"` select opens a modal with three text inputs.
- **Hub lockdown — temporary kill switch for one or all hubs (#13).** When a hub is locked, the bot denies `Connect` on `@everyone` for the underlying voice channel so Discord blocks joins entirely. Two scopes: per-hub (sudo can lock a single hub for 1–1440 minutes via modal) and server-wide (bot-owner-only — preset 15 m / 1 h / 4 h buttons lock every hub in the guild at once). Per-hub state lives on `hub_channels.lockdown_until`; server-wide state lives in `bot_settings` under `voice.guild_lockdown_until`. Both persist across restarts via `restoreHubLockdowns(client)` in the reconciler startup path. UI: `/sudo → Settings → Hub Channels → 🚨 Lockdown` opens a dedicated panel. Per-hub unlock respects server-wide lockdown — it won't punch a hole in the guild-wide policy.
- **Owner grace — original owner has 5 min to reclaim their auto-channel.** When the owner leaves a non-empty auto-voice channel, the bot now holds their owner slot for `voice.owner_grace_ms` (default 300000 ms; configurable in `/sudo → Settings → Voice`; 0 disables and restores the old instant-transfer behavior). `owner_user_id` stays pointed at the original owner so they never lose text-channel access and rejoining the VC restores them automatically. `acting_owner_user_id` is set to an in-channel host first (first user in `host_user_ids` who's still present) or, failing that, the longest-tenured remaining member. The acting owner gets text-channel access for the duration of the grace. The control panel shows "host @owner _(away — returns by <t:N:R>)_ · acting host @acting" while grace is active. Acting owner can use non-destructive panel actions (Rename, Lock, Hide, Templates) but NOT Delete, Hosts, or Claim. If the acting owner ALSO leaves, the grace is cancelled and ownership transfers permanently to whoever's still in the room. Grace state persists in `auto_channels` and is re-scheduled on bot startup by the reconciler.
- **Auto-thread channels: only thread messages with media.** Auto-thread channels (clips, food, etc.) no longer spawn threads on plain-text chatter. Threads only get created when the message has an attachment or a resolved link embed. Embeds populate asynchronously after `messageCreate`, so we re-check on `messageUpdate` once Discord renders the link preview.
- **`/sudo → Settings → Voice → No Voice Channel Messages` toggle.** When on, the bot replies to messages sent in an auto-voice channel's built-in chat with a pointer to the attached text channel ("Heads up — this voice channel has its own text channel just below…"). Per-(channel, user) 5-minute cooldown. Setting key `voice.no_voice_chat_messages`, default off.

### Fixed
- **Control panel updates no longer silently fail when the bot is in multiple guilds.** `postOrUpdateControlPanel` and its two helper resolvers were calling `client.guilds.cache.first()` instead of looking up the auto-channel record's own guild. With more than one guild in cache, `.first()` could return the wrong guild and every `channels.fetch()` failed with `GuildChannelUnowned` ("The fetched channel does not belong to this manager's guild") — silently, because the error was swallowed by `.catch(() => null)`. Now uses `client.guilds.cache.get(record.guildId)` throughout, plus a cache-first lookup on the text channel so transient API hiccups don't stall the panel until the next voice event. On cache miss the diagnostic log now includes the actual error code / status / message so any future recurrence is debuggable instead of guessable.

### Changed
- **Bot presence is now a Custom Status — no "Watching" prefix, just the relative-time stamp.** Activity type flipped from `Watching` to `Custom`, so Discord renders the status as plain text (e.g. `12m ago` / `just now`) without a verb in front. `_lastUsedAt` is now persisted to `bot_settings` under `presence.last_used_at` and re-read on boot (via the existing settings cache, hoisted ahead of `initPresence` in `ready.ts`), so the stamp survives weekly auto-restart, deploys, and container recreation — the bot doesn't show up "fresh" right after a restart anymore. DND status text also uses Custom now for the same prefix-free look.

### Added
- **`/sudo → Settings → Games → Add Game` auto-creates the Discord role + channel.** The Add Game modal used to just persist the catalog row, leaving sudo to manually wire up `pingRoleId` and `channelId` afterwards. Submitting the modal now also calls `provisionGameDiscord(guild, game)` which mirrors the staff-roles pattern: link by name match if a role/channel with that name already exists, otherwise create. New roles are mentionable + non-hoisted with no permissions. New channels are `GuildText` with `@everyone` denied `ViewChannel` so the per-member view overwrite path stays the gate. Default parent category is a new `channel.games_category` setting, configured via a category select right on the catalog list panel — falls back to top-level if unset. The new game's detail view renders with the IDs already filled in, and an ephemeral followup summarizes whether each asset was created, linked, or failed. New customId `games:cat:set_category` (channel-select).
- **`/settings → Staff Role` — self-service staff Discord role management.** New panel listing all 7 staff roles with per-role status (✅ holds / ➕ doesn't hold / 🚫 not linked / ⚠️ linked id missing in Discord). Behavior is gated by sudo:
  - **Sudo** can grant or remove ANY of the 7 roles on themselves directly — they already have authority, so the request/approval gate is just ceremony for them.
  - **Non-sudo** can REMOVE any staff role they currently hold (always safe — no privilege gain). To **add** a role they don't have, the panel includes a **Request a Staff Role** button that routes to the existing approval flow (`open_staff_request`).

  customIds: `settings:staff_role` (open panel), `settings:staff_role:add:{slug}` (sudo grant), `settings:staff_role:remove:{slug}` (anyone remove from self).

## [0.8.2] — 2026-05-08

Cumulative since 0.7.0 — picker-driven staff request flow, naming-only voice templates, social feeds (RSS-driven channel auto-poster), Game Night preview/edit/send + free-form game names, /games sudo "missing setup" warnings, presence "last used X ago", and a sweep of mention / URL / cv2 / dedup hardening across the bot. Held back from 1.0 — that's a deliberate deferred milestone — but this is the most stable release we've cut.

### Refactor
- **Reconciler fetches each tracked auto channel's text channel once per pass instead of twice.** The auto-rename retry and the permission sync each did their own `guild.channels.fetch(record.textChannelId)`. Hoisted to one fetch shared between both, halving channel-fetch HTTP calls during reconciler runs (1 per record instead of 2). N records × 1 fetch saved per boot / restart.

### Changed
- **Game Night accepts free-form game names — no catalog match required.** The setup modal no longer rejects a game query that doesn't resolve in the catalog (typical for one-off / TBD / itch.io games that don't have their own role+channel). The announcement renders the typed name verbatim. RSVP / ownership / cancel / preview-edit handlers no longer perform a catalog lookup at all. Modal field label updated to make the free-form behavior obvious. Recovered `recoverFromMessage` no longer needs `findGameByNameOrAlias` either.
- **Bot presence now shows "last used X ago" — refreshed every 5 min, idles after 60 min.** Status text is now `Watching auto voice channels · last used 12m ago`. Updates are throttled to 5-minute intervals (well above Discord's PRESENCE_UPDATE rate limit floor) and coalesce — back-to-back interactions don't spam Discord. Idle threshold bumped from 15 min to 60 min, and the idle status keeps the same "last used X ago" string visible (was empty before).

### Security
- **Client-wide default `allowedMentions: { parse: [] }`.** Set on the discord.js Client constructor so every reply / send / followUp defaults to "no mentions resolve" — defends against any code path that interpolates user-supplied text (Game Night notes, voice rename, staff-request reason, /report description, social-feed item body, etc.) and accidentally embeds `@everyone` / `@user`. Call sites that legitimately need to ping (e.g. `/play` LFG ping role) override explicitly with `allowedMentions: { roles: [...] }`.
- **Social poller URL hardening.** The third-party RSS items the poller renders (`item.link` → Link button URL, `item.imageUrl` → MediaGallery URL) are now gated to `http:` / `https:` via `URL` parsing. A malicious feed serving a `javascript:` / `data:` URL no longer reaches the Discord client at all; the link button or image is simply omitted.

### Added
- **`/sudo → Settings → Socials` — RSS feed → Discord channel auto-poster.** New `social_feeds` table + sub-panel for sudo to wire one or more RSS feeds (e.g. third-party Instagram / X / YouTube aggregators like rss.app) into a Discord channel. Default post channel is `1121170598417154110`, overridable per feed. Each feed has Add (modal: label + URL + channel ID, with the default pre-filled), Toggle Enabled/Disabled, Test (post the latest item without marking it seen), and Remove buttons. Background poller runs every 30 min by default (override via `bot_settings.social.poll_interval_ms`); fetches RSS, dedupes by item GUID, posts new items oldest-first as Components V2 cards (image preview + "View on {platform}" link button, accent color per platform). First poll for a fresh feed seeds the dedupe key silently so the existing backlog isn't replayed. Errors are surfaced in the per-feed detail panel via `last_error`. Hand-rolled RSS / Atom parser in `services/social/rssParser.ts` so no new npm dependency. Public posts use `allowedMentions: { parse: [] }` so embedded `@user` / `@everyone` text never resolves to a real ping.
- **`/games` shows a `⚠️ missing view-role, channel, ping-role` warning next to each game's name when the viewer is sudo.** Surfaces partially-configured catalog rows inline (instead of needing to dig into `/sudo → Settings → Games` to discover them). Regular members don't see the warning. `renderPrefsEditor` / `renderPrefsList` now take an optional `viewerIsSudo` flag (defaults to `mode === 'sudo'`); `/games` (mode='self') passes the actual sudo check so a sudo running `/games` on themselves still sees the warnings.

### Changed
- **Game Night never pings the game's ping role anymore, and posts only after a preview-confirm step.** `/sudo → Game Night` modal submit now opens an ephemeral preview of the announcement with three buttons: **📨 Send** (posts publicly), **✏️ Edit** (re-opens the modal **pre-filled with the values you just typed**), **✖️ Cancel** (discards). Previously the modal submit posted immediately and pinged `game.ping_role_id`. The public post now uses `allowedMentions: { parse: [] }` so no mentions in the body — game role, host, RSVP names — ever fire a notification. Pending previews live in a 30-min in-memory cache keyed by a short random session key.
- **Voice naming templates are now naming-only and presence-driven.** The Templates picker dropped **Comp 5-stack** and **Tryhard** because they set `userLimit` as a side effect of being clicked — that's why your channel kept ending up capped at 5. The user is now the only authority on per-channel user limit (set it via Discord's channel-settings UI). Replaced with seven naming styles: **Auto** (default `(N) Game`, count-prefix when 2+ members play the same), **Counter** (`Game [N]`), **Squad** (`Game · N squad`), **Detail** (`Game — {details}` from rich presence), **State** (`Game — {state}`), **Party** (`Game (X/Y party)` when rich presence reports a party), **Stealth** (bare game name). **Chill** stays as the only fixed-name template (sets `{member}'s Chill Session` and disables auto-rename until you pick a presence-driven template again).
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
