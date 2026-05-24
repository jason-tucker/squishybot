# Changelog

All notable changes to SquishyBot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.8.4] — 2026-05-24

### Security
- **Four new `bot_settings` knobs now have write-time validation in the sudo modal.** `play.default_cooldown_seconds`, `rxnroles.max_expires_minutes`, `rxnroles.default_expires_minutes`, and `voice.max_hosts_per_channel` were absent from `NUMERIC_SETTINGS`, so the sudo modal fell through to the generic string fallback and would persist any string (`"abc"`, `"NaN"`, a 10MB body). Read-time clamping in `getIntSetting` was the only line of defense. Added entries with bounds mirroring the read sites so garbage is rejected up front. Closes #130.

_v0.8.4 · 2a1725e_

---

## [0.8.3] — 2026-05-24

### Security
- **`getIntSetting` now treats empty/whitespace cached values as unset and returns the fallback.** `Number('')` and `Number(' ')` both yield `0`, which silently bypassed the fallback path — an operator who blanked out e.g. `voice.max_hosts_per_channel` in the panel got `0` ("unlimited") instead of the intended default. Not exploitable today but a real foot-gun if any knob's `0` semantics ever shifts. Closes #129.

_v0.8.3 · 6387d41_

---

## [Unreleased]

### Added
- **Four new `bot_settings` knobs for recent RPC features**, all editable from the panel's generic key/value editor at `/squishy/settings`:
  - **`play.default_cooldown_seconds`** (int, default 1800) — overrides the hardcoded 30-minute fallback used when a `games.play_cooldown_seconds` row is null. Clamped to `[0, 86400]`; 0 disables cooldown entirely. Read in `services/games.ts → cooldownSecondsFor`.
  - **`rxnroles.max_expires_minutes`** (int, default 43200 = 30 days) — caps the "expires in N minutes" input for temporary reaction-role messages on `rxnroles.create`. Operators can lower this to keep panel users from posting messages that linger for a month by accident; can't be raised above the hardcoded 30-day ceiling. Bot revalidates on every create so a stale panel page can't bypass an operator-lowered cap.
  - **`rxnroles.default_expires_minutes`** (int, default 60) — pre-fill for the panel's "expires in N minutes" input. Read by the panel only; the bot doesn't consume this.
  - **`voice.max_hosts_per_channel`** (int, default 0 = unlimited) — caps the host count on each auto-channel. Wired into `services/voice/hostsService.ts → toggleHost`; returns the new `host-cap-reached` error when an `add` would push the count over the cap. Removals are always allowed even when at/over the cap, so operators can lower the setting and then prune. Clamped to `[0, 50]`.
- **`getIntSetting(key, fallback, bounds?)` helper in `services/settings.ts`** — parses cached string values to bounded integers with `Math.trunc` + `[min, max]` clamping. Used by all four knobs above and any future integer-typed setting. Anything non-numeric falls back to the supplied default so an operator typo can't crash the bot.

- **`play.post` RPC verb — panel-triggered LFG post mirroring `/play`.** Accepts `{ gameId, hostUserId, message?, ping?, enforceCooldown? }` and reuses the same Components V2 panel + four-button layout as the slash command. Implemented by extracting the channel-resolve / perm-check / send-and-track flow from `commands/play.ts` into a shared `postLfg(client, opts)` helper that both surfaces call. Errors return machine tokens (`game-not-active`, `cooldown` with `remainingSec`, `channel-unreachable`, `bot-missing-perm`, `discord-error`, etc.) so the panel can localize messaging. Default `enforceCooldown=true` so the panel button can't bypass the 30-min cap any easier than spamming the slash command can. Closes botpanel #216 in conjunction with the matching panel-side route + UI.

- **`/play` gets two new options: `message` (optional string) + `ping` (optional boolean, default true).** `message` is rendered as a quoted block on the CV2 panel between the header and the player list (markdown allowed; mentions stay parse-disabled so the text can't fire pings). `ping=false` suppresses the role mention in the header AND drops the role from `allowedMentions.roles` — so a host can post a notice for an existing chat without buzzing everyone. The Notify Toggle button still works normally for subsequent users either way. Session state and the message-component recovery path both persist the host message so clicks (I-want-to-play, Cancel) re-render the panel without losing it. **Requires `pnpm commands:deploy` on the VPS after merge** so Discord registers the new options. Closes #121.

- **`/play` panel gets two more buttons: ❔ Help and 🔔 Notify Toggle.** A new second action row below the existing `🎮 I want to play!` / `✖️ Cancel` row. **Help** posts an ephemeral explainer of what `/play` is, what each button does, the 30-min cooldown, and how to mute pings — answers "wtf is /play?" without spamming the channel. **Notify Toggle** flips the clicker's membership in the game's ping role: add if missing, remove if present. The PUBLIC button label is static (Discord can't render different labels per viewer on a shared message) but the ephemeral confirmation owns the contextual framing — `"🔔 Get Notified — you'll be pinged when someone runs /play <game>"` when adding, `"🔕 Muted — you won't be pinged"` when removing. Notify is hidden entirely when the game has no `ping_role_id` configured. Closes #119.

- **Cache-invalidate subscriber — bot reloads `bot_settings` cache on demand instead of requiring a restart.** New service `src/services/cacheInvalidator.ts` lazy-subscribes to `bot.squishy.settings.invalidate`; on HMAC-verified messages from botpanel it calls `loadSettings()` so panel edits to welcome/goodbye templates, staff role mappings, channel IDs, social-feed config — every `bot_settings` key — take effect immediately. Bad HMAC drops silently with a warn. Missing `BOTPANEL_RPC_SECRET` disables the subscriber entirely (with a warn at boot) — bot still runs fine. Wired into `ready.ts` after `startRpcServer`. Closes botpanel #33 / V3-1 in conjunction with the panel-side publisher (botpanel PR #206) and the otterbot counterpart. Future tables (`games`, `hub_channels`, `auto_thread_channels`, `social_feeds`) will land additional `switch` cases in `handleInvalidate`.

- **`discord.create_role`, `discord.create_channel`, `game.provision` RPC verbs** — backing the new "+ Create" inline buttons on the panel's games editor (for filling missing role/channel links one resource at a time) plus the new "Auto-provision channel + view role + ping role" checkbox on the Add Game form. `game.provision` is the high-level atomic verb: it creates the games-category text channel (defaults to position 3, prefix `🎮-`, slugged game name), a view role (named after the game), and a ping role (`{name} LFG`, mentionable), then inserts the `games` row wiring all three IDs. Best-effort rollback on partial failure (deletes whatever's already created). Idempotent on `name` — returns `game-exists` with the existing row id. Parent-category resolution: explicit param → `bot_settings.channel.games_category` → top-level (no parent).
- **`voice.toggle_host` RPC verb** — panel can add or remove an auto-channel host via the dashboard. Extracts the `/voice → Hosts` slash-select logic into a shared `hostsService.toggleHost()` helper so slash + RPC are byte-identical (race-safe SQL array mutation, text-channel permission sync, hidden-VC ViewChannel overwrite, control-panel refresh, `voice.hosts_changed` Redis event).

### Changed
- **`users.resolve` RPC now fetches missing members from Discord** instead of returning null for users not in the in-process cache. The bot has GUILD_MEMBERS intent but doesn't pre-warm the cache at boot, so static members fell through to the raw-snowflake fallback on the panel (visible on `/squishy/voice`, audit tables, staff approvals). Fetch fallback is concurrency-bounded (5 parallel) so a stale chunk of 100 ids doesn't fan out into 100 parallel REST calls. Each fetch primes the cache for future calls.

### Added

- **`color.assign` RPC verb** — sudo applies / clears a curated color role for any member from the panel's new `/squishy/members/[id]` editor. Params `{userId, roleKey: string | null}` — `null` clears every curated color role the user holds; otherwise removes the rest and adds the picked one, preserving the one-color-at-a-time invariant the `/color` slash flow already enforces. Validates `userId` resolves in the configured guild and (when non-null) `roleKey` matches a row in `color_roles`. Returns `{userId, roleKey, applied}` where `applied` is true when at least one Discord role mutation happened.
- **`games.set_prefs` RPC verb** — panel calls this from `/me/games` to apply view/ping role toggles for the requesting user. Delegates to the same `applyUserGamePrefs` helper the `/games` slash flow uses, so behavior is identical.
- **`report.submit` RPC verb** — panel mirrors the `/report` slash modal: same fields, same DM-owner approval, same GitHub issue creation. Verb delegates to a shared `reportRequestService` helper.

### Ops

- **Schema-change → botpanel dispatch.** New `.github/workflows/notify-panel-schema-change.yml` fires a `repository_dispatch` (`bot-schema-changed`) at `jason-tucker/botpanel` whenever a push to `main` touches `src/db/schema/**`. Botpanel's companion `sync-bot-schema` workflow opens or updates a PR with the re-vendored Drizzle schemas. Closes the race where botpanel's `main` could go red after a schema merge here. Auth: `BOTPANEL_DISPATCH_PAT` repo secret.

### Fixed

- **Reconciler no longer adopts untracked voice channels.** Previous behavior: any occupied VC inside the auto-voice category that wasn't already in `auto_channels` got auto-adopted with `source_hub_id='recovered'`, after which it inherited the empty-channel-cleanup timer. That over-reached — manually-created channels inside the auto category were getting swept up and deleted on the first empty cycle. Now: untracked channels are logged-only; the bot leaves them alone. The original "bot was offline when someone joined a hub" justification is rare enough that re-joining the hub when the bot's back up produces a correctly-tracked channel instead.

- **Cleanup scheduler refuses to schedule cleanup for `source_hub_id='recovered'` rows.** Defensive guard for the legacy adopted-channel rows from before the reconciler-adopt change. A user-reported case (channel id `1368013630351740938`) had an `'recovered'` row from a startup adopt; the row was deleted manually but this prevents the same shape causing harm on any future startup that re-adopted before the reconciler change above.

- **Bot now connects to its own postgres via `db-squishy:5432` alias instead of `db:5432`.** Both squishybot-db and otterbot-db attach to the shared `botpanel-net` network with `db` as a default service-name alias, so DNS round-robined between them — the bot was occasionally hitting otter-db with squishy's credentials, throwing `password authentication failed for user "squishybot"` on every voice state update. Symptom: auto voice channels not working at all (every `voiceStateUpdate` handler call swallowed an error). Fix: pin to the unique `db-squishy` alias that the compose already sets up on botpanel-net. Same pattern as the redis-profiles fix on the panel side.



- **Staff base-role rename: `it_cri_staff` → `itsri_staff`, "IT CRI Staff" → "ITSRI Staff".** The actual Discord role name is **ITSRI Staff**, not IT CRI Staff. Renamed slug + key + label + name in `STAFF_ROLE_DEFS` and every user-facing string referencing it. Safe rename — no `staff_approvals` rows or `bot_settings` entries with the old slug/key exist yet (original entry shipped a few hours earlier and `/sudo → Provision & link` hadn't been run). Provision & Link will now match the existing "ITSRI Staff" Discord role by name.

### Changed

- **Staff request flow now picks Department + Tier separately, both optional, in one submission.** The previous single-role picker forced you to file two requests if you wanted Tier 2 + Help Desk. The new flow ships an ephemeral message with TWO selects (department / tier) plus a "Continue" button — picking any value updates the message state in place (state rides in customIds so it survives the round-trip), and Continue opens a one-field modal for the optional real / preferred name. The free-text **"Why are you requesting this role?"** field is removed entirely; pickers + name are the whole form. New `staff_approvals.requestedData` shape: `{department_key?, department_label?, tier_key?, tier_label?, real_name?}`. Legacy single-role rows still render in the approval card and DM correctly — see the "Approval" entry below for how they're granted.
- **Approval now grants up to 3 roles at once.** For new requests: the picked department (if any) + the picked tier (if any) + the new **ITSRI Staff** base role (always). Each grant gets its own line in the approval card so a partial failure (one role unlinked, another missing in Discord) is visible to the reviewer. Legacy single-role rows continue to grant exactly the one role they originally requested — they do NOT auto-pick up the new ITSRI Staff base role (it wasn't promised when those rows were filed; the card mentions this explicitly).
- **`bot_settings` keys for staff roles now include `staff.role.itsri_staff`.** The role is provisioned and linked by the existing `/sudo → Settings → Staff Roles → Provision & link` flow — same registry, just one more entry. Color `#3B88C3`. If you have an existing "ITSRI Staff" role in Discord it will be linked by name (no duplicate created).

### Added

- **`staff.request` RPC verb** — panel-side self-service "Request a staff role" flow. Mirrors the `/settings → Staff Role` modal exactly: inserts a `staff_approvals` row and posts the same Components V2 approval card (with Approve/Deny buttons) to `STAFF_APPROVAL_THREAD_ID`, pinging `STAFF_APPROVAL_PING_USER_ID` if set. The submit logic is extracted to a shared `staffRequestService.ts` so modal + RPC produce byte-identical Discord output. Returns `{approvalId, approvalMsgId, roleLabel}`; structured errors for `unknown-role` / `thread-unset` / `thread-not-thread` / `send-failed` (in which case the row is still saved and the panel surfaces a "saved but post failed" message).

### Changed

- **`interactions/modals/staffRequest.ts` now delegates to `staffRequestService.submitStaffRequest()`.** No behavior change — same row shape, same card, same ping. Refactor exists so the new `staff.request` verb shares one canonical implementation.

### Added

- **Three meta RPC verbs (`meta.list_roles`, `meta.list_channels`, `meta.list_members`)** — read-only listings powering panel-side pickers. Pure cache reads; zero Discord API hits. Members verb supports query+limit for typeahead.
- **`users.resolve` RPC verb** — batch lookup of `[{id, username, displayName, avatarUrl}]` for up to 100 snowflakes. Pure cache read; returns null fields for users the bot doesn't have cached so the panel can fall back to displaying the raw id.

- **`games.refresh_cache` RPC verb (Wave 7b).** New side-effect handler at `src/services/rpc/handlers/games/refresh_cache.ts` (wired in via `src/bot/events/ready.ts`) that re-runs `loadGames()` to repopulate the in-memory `catalog` Map and replies `{ ok: true, data: { gameCount } }`. Botpanel calls this after every games-table mutation (add/update/remove from the new `/squishy/games` CRUD surface) so the bot's cache stays in sync with the DB without waiting for a restart or a `/sudo → Debug → Force-clear caches` round-trip. Pure cache-invalidation — DB writes themselves happen panel-side, the bot just reloads its read-cache.

- **Reaction-role command-bus verbs (Wave 7b).** Three new handlers under `src/services/rpc/handlers/rxnroles/` registered on boot via side-effect imports in `bot/events/ready.ts`:
  - `rxnroles.create` — params `{channelId, body, mappings:[{emoji, roleId}], isTemporary?, expiresInMinutes?}`. Fetches the channel, posts the body, seeds each mapping as an initial reaction so users have a click target, then inserts the `reaction_role_messages` row + per-mapping `reaction_role_mappings` rows keyed by the new message ID. Temporary mode stamps `expires_at = now() + N min` so the existing 5-min cleanup tick handles teardown. Validates 1..20 mappings, 1..43200 min expiry, snowflake-shaped IDs; custom-emoji `<a?:name:id>` syntax is narrowed to the numeric ID before insert. Returns `{ok:true, data:{messageId, channelId}}`.
  - `rxnroles.delete` — params `{messageId}`. Deletes the Discord message if still present (wrapped — a manual delete is fine), removes the `reaction_role_messages` row + cascade mappings, pops the in-memory cache. Returns `{ok:false, error:'not-found'}` if the row didn't exist so the panel can show a friendly "already removed" state.
  - `rxnroles.expire` — same teardown as delete but logs with `action:'expired'` so operator forensics can tell "panel-clicked delete" from "panel-forced early expiry". Useful for game-night messages whose timer is set too far out.

- **Wave 7b hub-channel command-bus verbs.** Three new RPC handlers under `src/services/rpc/handlers/hubs/` register against the Wave 7 command-bus scaffolding so the panel can drive hub lockdown + DB-only CRUD from `/squishy/hubs`.
  - **`hub.lockdown`** (`{hubChannelId, locked, durationMinutes?}`) — per-hub lock/unlock. Snowflake-validated `hubChannelId`; `durationMinutes` is optional (defaults to 1440 = 24h), capped at 30 days, must be a positive integer. Delegates to the existing `lockHub` / `unlockHub` in `hubLockdown.ts` so DB persistence, scheduled-unlock timers, server-wide-policy-preserving unlock, and `voice.lockdown_started/ended` Redis fan-out are unchanged.
  - **`hub.lockdown_all`** (`{locked, durationMinutes?}`) — guild-wide via `lockAllHubs` / `unlockAllHubs`. Returns `{count}` (hubs in the configured guild, read from the in-memory cache) so the panel can show "applied to N hubs" feedback without a follow-up read.
  - **`hub.refresh_cache`** (`{}`) — reload the in-memory `hubsCache` from `hub_channels` so a panel-side INSERT/UPDATE/DELETE (no Discord-side work needed) takes effect immediately. Backed by a new focused `reloadHubsCache()` helper in `settings.ts` that only touches the hubs map — `loadSettings()` would also clear sudo users, auto-thread configs, etc., which is too broad for a hot-write refresh. Returns `{hubCount}`.
  - Wiring: new `src/services/rpc/handlers/hubs/index.ts` side-effect-imports the three handler files; `ready.ts` imports the barrel right after the `echo` import so registration fires before any messages arrive.
- **Voice-control RPC verbs (Wave 7b).** Six new handlers under `src/services/rpc/handlers/voice/` register on the Wave-7a command bus so the botpanel `/squishy/voice` page can drive every auto-channel mutation the in-Discord control panel exposes:
  - `voice.rename` — `{voiceChannelId, newName}`, sanitizes via `utils/channelName.sanitizeChannelName`, sets the VC + text-channel names, flips `manual_name` + `auto_name_enabled=false` + `fallback_name`, then `postOrUpdateControlPanel` so the in-channel panel matches.
  - `voice.lock` — `{voiceChannelId, locked}`, edits the `@everyone` Connect overwrite (false to lock, null to unlock), persists `is_locked`, publishes `voice.lock_toggled`.
  - `voice.hide` — `{voiceChannelId, hidden}`, denies/restores `@everyone` ViewChannel and re-grants explicit allows to bot + owner + hosts + `SUDO_ROLE_IDS` so hiders don't lose their own room. Publishes `voice.hidden_toggled`.
  - `voice.disconnect` — `{voiceChannelId, userId}`, sets the target member's voice channel to `null`; guards against yanking someone out of an unrelated room (rejects with `member-not-in-channel` if their current VC doesn't match).
  - `voice.transfer` — `{voiceChannelId, newOwnerUserId}`, cancels any active grace timer, drops the new owner from `host_user_ids` if present, clears the acting-owner fields, resyncs text-channel perms via `syncTextChannelPermissions`, publishes `voice.owner_changed`.
  - `voice.delete` — `{voiceChannelId}`, delegates to the existing `deleteAutoChannel` service so timers, channels, DB row, member rows, and the `voice.channel_deleted` event all clean up the same way the in-Discord Delete button handles them.
  Each handler uses an inline zod schema (no new dep — bot already vendors zod), 404-style errors for missing rows (`channel-not-found`), Discord API errors surface as `{ok:false, error:'discord-error', details:msg}`. Handlers self-register on import; a new `src/services/rpc/handlers/voice/index.ts` barrel is side-effect-imported once from `bot/events/ready.ts`. Pairs with the matching botpanel PR for the panel-side surfaces + `POST /api/squishy/voice/[id]/{rename,lock,hide,transfer,disconnect}` + `DELETE /api/squishy/voice/[id]` routes.
- **Bot-side Redis command-bus subscriber (Wave 7 foundation).** New `src/services/rpcServer.ts` opens a separate `ioredis` subscriber (the existing publisher in `eventBus.ts` can't be reused once it enters subscriber mode) and `psubscribe`s to `cmd.squishy.*`. Each incoming envelope (`{ requestId, ts, hmac, params }`) is verified against `BOTPANEL_RPC_SECRET` via a constant-time HMAC-SHA-256 compare (`src/utils/hmac.ts`), replay-guarded (30 s `ts` window + in-memory single-use LRU of recent request IDs, capped at 5000), then dispatched to a handler from the new `src/services/rpc/registry.ts` lookup table. Replies go back on `res.<requestId>` via the existing `eventBus.publish` so we don't open a third Redis connection. Unknown verbs reply `{ ok: false, error: 'unknown-verb' }`; handler throws turn into `{ ok: false, error: 'handler-threw' }`; HMAC mismatches drop silently (no oracle). Non-blocking — if `BOTPANEL_RPC_SECRET` is unset, `startRpcServer` logs a warning and skips subscribing so the bot still runs without the panel wired up; `enableOfflineQueue: false` + capped exponential retry keep Redis outages soft. Ships with one proof verb — `echo` (`src/services/rpc/handlers/echo.ts`) — that round-trips `params` plus a server timestamp so the panel can validate the full HMAC + replay + dispatch path end-to-end. Actual Discord-side verbs (voice control, role grants, etc.) land in follow-up PRs that just `registerVerb(...)` against this scaffolding.

### Fixed
- **`voiceStateUpdate` handler now wraps its body in a try/catch boundary** so a transient DB blip (or any other thrown error inside the async handler) becomes a `logger.error` instead of an uncaughtException. Discord.js executes async listeners via `Promise.then` with no error boundary — a rejected promise crashed the worker. Symptom: a single `password authentication failed` from postgres-js mid-burst surfaced as an uncaught exception in the join handler, so the user's hub join no-op'd silently. The wrap doesn't paper over the root cause (a pool connection that lost SCRAM negotiation — likely a transient race), just prevents one bad event from looking catastrophic.

### Changed
- **Deploy pipeline now uses GHCR + watchtower** (matches the botpanel pattern). `BOT_IMAGE` defaults to `ghcr.io/jason-tucker/squishybot:latest` and the container gets the `com.centurylinklabs.watchtower.enable=true` label so the shared watchtower picks it up. Closes the gap that left squishybot running a stale local image for 4 days. After merging, the user needs to `docker login ghcr.io` (once) so watchtower can pull the private package, then `docker compose pull && up -d` to switch from the local image to the GHCR floating tag.
- **Startup DM is now a Components V2 card** instead of a markdown blob. Same content (bot tag, booted-relative timestamp, version + git SHA, primary guild, reconciler results, disabled feature flags) but rendered in a green-accented `ContainerBuilder` with separators between sections. Still env-only target (`BOT_OWNER_ID`).

### Security
- **Postgres host port closed.** `5434` is no longer bound to `0.0.0.0`; the DB is reachable only over the new shared `botpanel-net` external docker network (alias `db-squishy`) and through `docker exec` from the VPS host. External port scans now show `5434/tcp` as closed/filtered.

### Changed
- **`squishybot` service now joins `botpanel-net`** in addition to the default compose network, so the event publisher can reach the panel-stack `redis:6379`. `REDIS_URL` env defaults to `redis://redis:6379` (override via `.env`). The default network is still where the bot reaches its own `db:5432`.

### Added
- **Redis event publisher (botpanel #14).** New `src/services/eventBus.ts` fans out bot-state mutations to Redis pub/sub on typed `bot.squishy.<domain>.<event>` channels. Lazy-singleton `ioredis` connection (env `REDIS_URL`, default `redis://redis:6379`), `lazyConnect: true` + capped exponential retry, never throws upstream (`publish()` is fire-and-forget; errors land in `logger.warn`). Inline TS interfaces define every payload shape; we'll dedupe with the panel's vendored copy later. Hook points:
  - **Voice** — `voiceMembers.recordMemberJoin / Leave` (`voice.member_join` / `member_leave` with `{guildId, userId, channelId, ts}`), `autoChannel.createAutoChannel / deleteAutoChannel` (`voice.channel_created` / `channel_deleted` with `{voiceChannelId, textChannelId, ownerUserId, name, ts}`), voice control panel button handler (`voice.lock_toggled`, `voice.hidden_toggled`, `voice.owner_changed` on Claim), hosts select (`voice.hosts_changed` with `{voiceChannelId, op, userId, ts}`), and `voiceStateUpdate` owner instant-transfer + acting-owner promotion paths (`voice.owner_changed`).
  - **Lockdown** — `hubLockdown.lockHub / unlockHub / lockAllHubs / unlockAllHubs` (`voice.lockdown_started` / `lockdown_ended` with `{hubChannelId, ts}` per hub or `{guildWide: true, ts}` for the all-hubs variants).
  - **Settings + sudo** — `setSetting / clearSetting` (`settings.setting_changed` with `{key, oldValue, newValue, by, ts}` — only when the value actually changes, mirroring the audit row), `addSudoUser / removeSudoUser` (`sudo.granted` / `sudo.revoked` with `{userId, by, ts}`).
  - **Member + report** — `guildMemberAdd` / `guildMemberRemove` (`member.joined_guild` / `member.left_guild` with `{userId, ts}`), `/report` modal submit (`report.created` with `{id, status: 'pending', ts}`), `/report` review buttons (`report.approved` / `report.rejected` with the same id once the decision lands).
  - **Heartbeat** — `ready.ts` emits a one-shot `bot.ready` on startup and `bot.heartbeat` every 60s via `setInterval`, both with `{version, uptime, ts}`. Uptime is process-local, measured from eventBus module load.
- **`/sudo → Settings → Debug` sub-panel — bot-owner diagnostic surfaces (#16, #33, #34).** New navigation tile on the Settings home. Three actions on the panel:
  - **Feature flags (#33)** — bot-owner-only toggles for `feature.auto_voice`, `feature.auto_threads`, `feature.social_poller`, `feature.presence_renames`, `feature.birthday_pings`, `feature.color_roles`. Each gates the relevant entry point at runtime (`handleHubJoin`, `maybeAutoThread`, social `runPoll`, `presenceUpdate`, birthday `runForDate`). Existing in-flight state isn't disturbed — flipping `feature.auto_voice` off just makes new hub joins no-op.
  - **Force-clear caches (#34)** — bot-owner-only button that calls `loadSettings`, `loadGames`, `loadSocialFeeds`, and `invalidateBotOwnerCache` so a stale cache can be force-reset without redeploying.
  - **Orphan resource scan (#16)** — walks `auto_channels`, `hub_channels`, `auto_thread_channels`, `games`, `archived_channels` and reports any rows referencing Discord channels/roles that no longer exist in `guild.channels.cache` / `guild.roles.cache`. The "Clean up orphan rows" button (bot-owner-only) deletes entirely-orphaned rows (every Discord reference gone); rows with partial orphans (e.g. a game whose `ping_role_id` is missing but channel still exists) are left intact so they can be edited.
- **Per-game `/play` cooldown override (#22).** New nullable `games.play_cooldown_seconds` column. Null = use the global default (1800s = 30 min). 0 = disable cooldown entirely. Edited via `/sudo → Settings → Games → <game> → /play cooldown` button (modal with sane error messages). `checkPlayCooldown` reads the per-game value through a new `cooldownSecondsFor` helper.
- **Ping role requires View role (#23).** `setPref` now refuses to set `wantsPing=true` for a game where the target member doesn't already have `wantsView=true`. Returns a discriminated `SetPrefResult` (`game-not-found` / `view-required-for-ping`); the gamesEditor handler surfaces the latter with: _"You need the **view** role for this game before you can opt into pings. Toggle View on first."_ Cascade also added: toggling View off now turns Ping off too (and strips the ping role) so a user can't end up holding a ping role for a channel they can no longer see.

### Added
- **`/sudo → Settings → Reaction Roles` — builder + temp game-night mode (#37).** New `reaction_role_messages` + `reaction_role_mappings` tables. Create flow: modal accepts channel ID, message body, mapping lines (`emoji=roleId` per line, supports both unicode and `<:name:id>` custom-emoji syntax), and an optional "Expires in N minutes" for temporary mode. Bot posts the message, seeds each mapping as an initial reaction, and watches `messageReactionAdd` / `messageReactionRemove` to toggle the mapped role on the reacting member. Cleanup tick (every 5 min) deletes expired temp messages and best-effort strips the granted roles. Added `GuildMessageReactions` intent + `Partials.Message` + `Partials.Reaction` so reactions on uncached messages still fire.
- **`/sudo → Settings → Welcome/Goodbye` editor (#20).** Two-template editor with toggles, channel selects, and modal-edited bodies. Supports `{user}`, `{server}`, `{member_count}`, `{account_age}` tokens. Both default OFF. New `registerGuildMemberRemove` event handler for the goodbye path. Welcome message uses `allowedMentions: { users: [member.id] }` so the `{user}` ping fires; goodbye doesn't ping anyone.
- **Game-channel auto-archive (#21).** Adds `games.auto_archive_days` (nullable, default null = OFF). 12-hour scheduler tick `startGameAutoArchiver` walks games with the field set, decodes each channel's last-message snowflake for an inactivity timestamp, and runs `archiveChannel` from the existing archive workflow when the channel has been silent that long. Edited per game on the games detail modal (validates 1–3650, blank/0 disables).
- **Sudo `/report` triage view — bot-owner-only (#24).** Every `/report` submission now persists to a new `report_log` table with status `pending`. Approve/Reject in the existing DM flow updates the row to `filed` (with the GH issue URL) or `dropped`. `/sudo → Settings → Debug → Report triage` shows the last 20 reports with status emoji, submitter mention, and issue link. Bot-owner gate via `isBotOwner` — other sudo see a denial.
- **`/sudo → Settings → Auto Roles` (#36).** New `auto_join_roles` table + Auto Roles sub-panel (role-select to add, string-select to remove). `guildMemberAdd` handler applies every configured role to new members, gated by the new `feature.auto_role_on_join` flag (default OFF). Visible from `/sudo → Settings → Auto Roles`.
- **`/sudo → Settings → Color Roles` + `/color` slash command (#38).** Curated `color_roles` table. Sudo manages via the Color Roles panel (role-select to add, string-select to remove). Members run `/color`, pick from the curated string-select, and the bot swaps any other color role they hold for the new pick. Gated by `feature.color_roles` (default OFF). Minimum-effort implementation per spec.
- **Better startup DM.** The boot DM to `BOT_OWNER_ID` (still env-only — the dynamic isBotOwner is for auth checks, not DM fan-out) is now a richer markdown card: bot tag with booted-relative timestamp, version + git SHA, guild list, reconciler results, and a "Feature flags" section that lists any DISABLED flags so a stale-off doesn't go unnoticed.
- **`/sudo → Settings → Debug` sub-panel — bot-owner diagnostic surfaces (#16, #30, #31, #32, #33, #34).** Six entries gated on `isBotOwner`:
  - **Heartbeat (#30)** — gateway ping, live DB latency probe, process uptime, version, git SHA, container start time, bot-owner count.
  - **Audit log (#31)** — new `setting_changes` table; every `setSetting` / `clearSetting` writes a row. Panel shows the last 20 changes with relative timestamps and key/old/new.
  - **Usage stats (#32)** — on-demand counts from existing tables for auto channels created, staff requests filed, settings changes — today + this week.
  - **Feature flags (#33)** — bot-owner-only toggles for `feature.auto_voice`, `feature.auto_threads`, `feature.social_poller`, `feature.presence_renames`, `feature.birthday_pings`, `feature.auto_role_on_join`, `feature.color_roles`. Each gates the relevant entry point at runtime.
  - **Force-clear caches (#34)** — reloads settings / games / social feeds and invalidates the bot-owner cache.
  - **Orphan resource scan + cleanup (#16)** — walks all bot-managed tables and reports / deletes rows whose Discord channels/roles are no longer in cache.
- **`/sudo → Settings → User Profiles → Bulk-import birthdays` + Example CSV download (#18).** Modal accepts CSV (`user_id,month,day` or `user_id,MM-DD` per line; `#` comments tolerated). Each row validated and upserted; reply summarizes imported count + per-line errors. Example CSV button delivers a real attachment via `files: …` for download.
- **Staff request history viewer (#25).** New "Staff request history" entry under Debug. Lists the most recent 20 `staff_approvals` rows ordered by createdAt desc with status emoji and role label.
- **Per-feed style preview using last item (#28).** New "Preview style" button on each feed's detail panel. Fetches the feed and renders the latest item as an ephemeral CV2 card using the same `buildSocialPostPayload` the poller uses, so the preview matches what would post. No side effects.
- **Per-feed max items per poll (#29).** New `social_feeds.max_items_per_poll` column (default 0). 0 = post only the single latest new item per poll. 1–3 allowed for sudo; higher requires bot owner. Throttled-off items still have their `lastSeenId` advanced so they don't resurface.
- **`/sudo → Settings → Auto Threads` — per-channel thread name template editor (#26).** Channels in the list now show their template inline. New "Edit thread name template…" StringSelect opens a modal pre-filled with the current value; tokens `{author}` and `{content}` are supported. Blank submission resets to default (`{author} — {first line}`).
- **`/sudo → Settings → Auto Threads` — per-channel thread archive duration (#27).** New "Set thread archive duration…" StringSelect routes to a sub-panel with four preset buttons (1h / 24h / 3d / 1w) plus Reset. Channel rows show the current setting; the currently-selected button is rendered in Success-green. Persisted as `archive_duration` minutes on `auto_thread_channels`; consumed by `messageCreate.ts` via the existing `archiveDuration` read.
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
- **Auto-rename now reliably falls back to the channel's `fallback_name` when nobody is playing a game.** Three compounding bugs were causing the channel to stay stuck on the last game's name:
  1. **Template filter dropped most templates.** `presenceUpdate` only ran for `null` / `'auto'` / `'counter'` — `squad`, `detail`, `state`, `party`, `stealth` were silently ignored. Now uses the full `ALL_TEMPLATES` set.
  2. **Throttled renames were dropped, not deferred.** Discord's per-channel rename rate limit is 2/10 min. The old handler bailed entirely when throttled — so a "stop playing" event within the cooldown window never triggered the fallback. The new pipeline schedules a single deferred retry that fires as soon as the bucket allows, and coalesces concurrent retries.
  3. **`voiceStateUpdate` never re-evaluated the name.** When the owner / driver of a game-derived name left the VC (or a new member joined who's playing something), the rename pipeline didn't run. Now both join and leave fire `maybeRenameChannel`.
- Centralized into new `src/services/voice/autoRename.ts`. Reconciler now calls the same function on boot, so a redeploy mid-presence reconciles cleanly. `presenceUpdate.ts` shrank from a manual hot path to a thin event-to-service handoff; `feature.presence_renames` flag still gates renames, but the control panel still updates on presence changes so the rich-presence list and "why this name" line stay live even when the flag is off.

### Added
- **Voice control panel: full rich presence + current name + reason.** The In-channel list now shows each member's game name, rich-presence `details`, `state`, and party size (when reported) on a sub-line below their tag. Below the member list, two new lines surface the live channel name and a plain-English explanation of why it's that name:
  - `Auto-rename off → manual / fixed template`
  - `Chill template → fixed name`
  - `Nobody is playing → falling back to <fallback>`
  - `Template <key> · N/M playing <Game> wins. <how the template formats it>.`
- The panel re-renders on presence changes (with hash dedup so silent edits don't fire).

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
