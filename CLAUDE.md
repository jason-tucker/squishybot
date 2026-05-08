# SquishyBot — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, systemd setup,
Discord.js patterns, Components V2, and database conventions that apply to all bots.

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

**Avoid command bloat for self-service entry points.** Don't register a top-level slash command for every per-user feature — push them through `/squishy`'s panel-with-buttons UX instead. Profile editing is reachable via the **Edit My Profile** button on `/squishy`, not a `/profile` command. Reserve top-level slash commands for high-frequency or high-value flows (`/games`, `/play`, `/voice`, `/report`).

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

Slash commands are consolidated to four top-level commands plus one context menu.

| Command | Description | Permission |
|---|---|---|
| `/voice` | Open an ephemeral copy of the control panel for the channel you're currently in | Owner/Host/Sudo |
| `/squishy` | User-facing menu: bot status, feature explainers, **Edit My Profile** button (opens profileEditor in self mode), Request Staff Role button | Everyone |
| `/sudo` | Admin select-menu panel: Settings, Manage user (pick), Game Night (schedule), Active VCs, Hubs, Force cleanup, Pending approvals, Run reconciler, Restart instructions. Sub-panels have 🏠 Back to /sudo. | Sudo |
| `/report` | Open a modal to file a GitHub issue (Title / Type / Description / Steps); owner approves via DM before it lands on GitHub | Everyone |
| `/games` | Pick which games you want View / LFG-ping roles for | Everyone |
| `/play <game>` | Post a CV2 LFG message in the game's channel with a "🎮 I want to play!" toggle button. 30-min per-(user,game) cooldown. State in-memory + parse-from-message fallback. | Everyone |
| Right-click user → **Manage** | Edit Profile, Game Prefs, voice status, disconnect, staff history | Sudo |

The persistent control panel (in each auto-channel text channel) is the primary
interaction surface. A silent sticky message at the bottom of every auto-channel
text channel keeps a quick `📋 Open Panel` button visible no matter how much
chat scrolls; clicking it gives you an ephemeral copy of the panel.

### Voice control panel buttons

| Button | What it does |
|---|---|
| ✏️ **Rename** | Modal to set a custom name |
| 🔒 **Lock** / 🔓 **Unlock** | Toggle Connect permission on `@everyone` |
| 👑 **Hosts** | One panel listing each member with their current rank emoji (👑 host · 🛡️ sudo · 👤 member). Clicking toggles host status. |
| 📋 **Templates** | Auto / Counter / Comp 5-stack / Tryhard / Chill — sets name + user limit in one click |
| 👤 **Claim** | Take ownership when the owner has left |
| 🗑️ **Delete** | Delete the voice + text channels right away |

## Terminal management

`scripts/squishybot` is the management CLI. Install once with
`sudo cp scripts/squishybot /usr/local/bin/squishybot && sudo chmod +x /usr/local/bin/squishybot`,
then use:

| Command | Action |
|---|---|
| `squishybot install` | First-time setup: systemd unit, migrations, deploy commands, start |
| `squishybot start` / `stop` / `restart` | Service control (restart runs migrations first) |
| `squishybot status` | systemctl status |
| `squishybot logs` | Tail live logs |
| `squishybot tail [N]` | Last N log lines (default 30) |
| `squishybot deploy` | Redeploy slash commands |
| `squishybot migrate` | Run DB migrations |
| `squishybot update` | git pull + migrate + redeploy + restart |

Weekly auto-restart at Tuesday 4 AM via `squishybot-restart.timer`.

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
| `user_profiles` | User display names, birthdays (with opt-out flags), staff fields (sudo-edits any field; `/profile` self-edits a subset) |
| `staff_approvals` | Pending staff role approval queue (future) |

### Staff role mapping

The 7 staff roles (Tier 1 / Tier 2 / Tier 3 / Help Desk / Onsites / Security / Leadership) are stored as `bot_settings` keys (`staff.role.tier_1`, …, `staff.role.leadership`) mapping role name → Discord role ID. Manage via `/sudo → Settings → Staff Roles`:

- **Provision & link** — idempotent: creates any missing Discord role (hoisted, no color, no perms), links by name into `bot_settings`, then bumps the 7 roles' positions to one above the highest game role's position.
- **Clear links** — removes the linked IDs from `bot_settings` (Discord roles untouched).
| `games` | Game definitions for role/channel management (future) |
| `user_game_prefs` | Per-user game view/ping preferences (future) |

---

## customId conventions

All voice control interactions use: `vc:{voiceChannelId}:{action}`

Actions: `delete`, `delete_confirm`, `rename`, `rename_submit`, `lock`, `unlock`, `hosts` (button + select), `claim`, `templates`, `template_apply` (select), `open_panel` (sticky button)

`/report` uses three customIds (no vc prefix):
- `report:submit` — modal submission
- `report_approve_notice:{sessionKey}` / `report_approve_silent:{sessionKey}` — file the issue (with/without DMing reporter)
- `report_reject_notice:{sessionKey}` / `report_reject_silent:{sessionKey}` — drop the session (with/without DMing reporter)

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
| `src/services/logger.ts` | Structured logging to console + optional LOG_CHANNEL_ID |

---

## Bot restart (production)

```bash
kill -TERM $(ps aux | grep "tsx.*src/index.ts" | grep -v grep | awk '{print $2}' | head -1)
sleep 5 && journalctl -u squishybot -n 10 --no-pager
```

## Deploy slash commands

```bash
pnpm commands:deploy
```

## Run database migrations

```bash
pnpm db:migrate
```
