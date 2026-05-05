# SquishyBot — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, systemd setup,
Discord.js patterns, Components V2, and database conventions that apply to all bots.

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

| Command | Description | Permission |
|---|---|---|
| `/squishy status` | Bot status: uptime, active channels, hub count | Everyone |
| `/squishy repair` | Manually run the reconciler | Sudo only |
| `/voice panel` | Re-post or open control panel (works from any channel if in a voice channel) | Owner/Host/Sudo |
| `/voice claim` | Claim ownership of an auto channel whose owner left | Anyone in the channel |
| `/voice delete` | Delete your auto channel | Owner/Host/Sudo |

The control panel in the auto text channel is the primary interface — `/voice` commands are
fallback escape hatches.

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
| `AUTO_VOICE_CATEGORY_ID` | Yes | Discord category ID for hubs and auto channels |
| `HUB_CHANNEL_IDS` | Yes | Comma-separated voice channel IDs that are hubs |
| `VOICE_CLEANUP_DELAY_MS` | No | ms before empty channel cleanup (default: 30000) |
| `LOG_CHANNEL_ID` | No | Bot posts structured log messages here |
| `ADMIN_CHANNEL_ID` | No | Sudo-only bot admin channel |
| `STAFF_APPROVAL_CHANNEL_ID` | No | Future: staff approval queue channel |
| `BIRTHDAY_CHANNEL_ID` | No | Future: birthday ping channel |
| `BLIPS_CHANNEL_ID` | No | Future: auto-thread channel |
| `FOOD_CHANNEL_ID` | No | Future: auto-thread channel |
| `UPTIME_KUMA_PUSH_URL` | No | Push monitor URL |

---

## Database schema

| Table | Purpose |
|---|---|
| `auto_channels` | Tracks active auto voice channels and their state |
| `hub_channels` | Registry of managed hub voice channels |
| `user_profiles` | User display names, birthdays, staff fields (future) |
| `staff_approvals` | Pending staff role approval queue (future) |
| `games` | Game definitions for role/channel management (future) |
| `user_game_prefs` | Per-user game view/ping preferences (future) |

---

## customId conventions

All voice control interactions use: `vc:{voiceChannelId}:{action}`

Actions: `delete`, `delete_confirm`, `rename`, `rename_submit`, `lock`, `unlock`, `add_host`, `remove_host`

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
