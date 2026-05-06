# SquishyBot

A multipurpose Discord bot for a single server. Built with discord.js v14, TypeScript, PostgreSQL, and Drizzle ORM.

## Quick install (any VPS with Docker)

```bash
# 1. Install Docker (skip if already installed)
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker

# 2. Install SquishyBot (replace YOURUSER with your GitHub username)
GITHUB_OWNER=YOURUSER bash <(curl -fsSL https://raw.githubusercontent.com/YOURUSER/squishybot/main/scripts/install.sh)
```

The installer verifies Docker, clones the repo, generates a strong Postgres password, opens `.env` so you can paste your Discord token + IDs, pulls the GHCR image, and starts the bot.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full setup guide and CI/CD configuration.

Roadmap, completed work, and open action items are tracked in the [Bot Development project board](https://github.com/users/jason-tucker/projects/3). Items use these statuses: **Todo**, **In Progress**, **Done**, **Tucker Action** (waiting on me), **Blocked** (with a Blocker note explaining why).

## Features

### Auto Voice Channels

- Join a **hub** voice channel → the hub converts into your personal voice channel (you stay in it)
- A replacement hub is immediately created
- An attached **text channel** appears, visible only to users in the voice channel + sudo users
- A persistent **control panel** message lets you rename, lock, add/remove hosts, claim, delete, or apply a template
- A silent **sticky button** stays at the bottom of the text channel (always `📋 Open Panel`) so the panel is one click away even after lots of chat
- **Templates** — Auto (follows your rich presence), Counter (live `[x/y]` member count), Comp 5-stack, Tryhard Mode, Chill Session
- Default channel name uses your active game; if you're not playing anything, you get a random tech-themed name like *Sloppy Ethernet*
- When the channel becomes empty, both voice + text channels are cleaned up automatically
- Bot repairs itself on restart (reconciler recovers orphaned channels, missing hubs, and stale panels)

### Staff Requests

- Submit a request via the `/squishy` panel
- Bot posts the request in a configured admin thread, pinging the designated reviewer
- Sudo can Approve or Deny in place; the requester gets a DM with the result

### Bug & Feature Reports

- `/report` opens a modal (Title / Type / Description / Steps to reproduce)
- The bot DMs the owner with the contents and four buttons: **Approve+Notify**, **Approve Silent**, **Reject+Notify**, **Reject Silent**
- On approve, the bot files the issue against `GITHUB_REPO` via the GitHub REST API and (optionally) DMs the reporter the issue URL

### Sudo Panel

- `/sudo` opens an admin select menu: **Settings**, active channels, hubs, force cleanup, pending approvals, run reconciler, restart instructions
- **Settings** is a runtime config editor — overrides the values that would normally come from `.env` for: extra sudo users, channel IDs (log / admin / birthday / staff approval thread), voice cleanup delay, the auto-voice category, the list of registered hubs, and the list of auto-thread channels. Reset on any field falls back to the env value.
- Settings persist in `bot_settings` (key/value), `sudo_users` (members granted sudo at runtime), `hub_channels` (DB-authoritative hub list), and `auto_thread_channels` (the dynamic auto-thread list).

### Auto Threads

- Configure under **/sudo → Settings → Auto Threads** — a `ChannelSelectMenu` to add, a `StringSelectMenu` to remove. No code changes required to onboard a new channel.
- Every non-bot, non-system message in a configured channel gets a public thread. Default thread name: `{author} — {first line}` (truncated to 100 chars). Per-channel `name_template` and `archive_duration` columns are reserved on the schema for future per-channel tuning.
- Requires the `MessageContent` privileged intent (Dev Portal → Bot).

### Birthday Pings

- Daily scheduler that fires at a configurable target hour (default 9 AM server time) and posts a celebratory message in the channel set under **/sudo → Settings → Channels → Birthday channel**.
- Members set their birthday via **/profile** (modal: month + day). They can opt out without deleting the date by toggling **Birthday pings**.
- Same-day restarts don't double-fire (idempotency via `bot_settings.birthday.last_run_date`).
- Leap-year birthdays (Feb 29) get celebrated on Feb 28 in non-leap years with a small note.

### User Profile Editor

- **Sudo edits anyone's profile** — `/sudo → Settings → User Profiles` lets a sudo member browse profiles by Discord member picker, or right-click any member → **Manage User → Edit Profile** for a faster path. Sudo can edit: display name, real name, birthday, staff category / department / tier / leadership title, and the birthday opt-out flags.
- **Self-service** — `/squishy → Edit My Profile` opens the same editor in self mode for the caller. Limited to display name, birthday, and the two birthday flags. All edits are logged.

### Game Roles + LFG Pings

- **Catalog (sudo)** — `/sudo → Settings → Games` lets sudo define games with a name, aliases, View role, Ping role, channel, optional category, sort order, visibility, and archive flag.
- **Member opt-in** — `/games` lists every visible game with two toggles per game: **View** (assigns the View role) and **Pings** (assigns the LFG Ping role). Toggling immediately syncs the role on Discord.
- **Sudo-acts-on-behalf** — sudo can right-click any member → **Manage User → Game Prefs** and toggle View / Pings on that member's behalf. Same UI, same flow. Same pattern applies to profile editing — `/squishy → Edit My Profile` for self, **Manage User → Edit Profile** for sudo.
- **`/play <game>`** — LFG ping. Autocompletes on name + aliases. Posts in the game's channel mentioning its Ping role. 30-minute per-(user, game) cooldown; sudo can pass `force:true` to bypass. Bot will never `@everyone` / `@here` regardless of arguments — user-supplied text has raw mentions stripped.

### Planned Features

_(Nothing currently on the active planned list — see [project board](https://github.com/users/jason-tucker/projects/3) for the latest backlog.)_

---

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your values
```

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GUILD_ID` | Yes | Single guild this bot serves |
| `AUTO_VOICE_CATEGORY_ID` | Yes | Default category for hubs and auto channels (overridable via `/sudo → Settings → Voice → Auto-voice category`) |
| `HUB_CHANNEL_IDS` | No | Comma-separated voice channel IDs to seed as hubs on first boot. Once registered, the DB is authoritative and this env var can be cleared. Add/remove hubs at runtime via `/sudo → Settings → Hub Channels`. |
| `SUDO_ROLE_IDS` | No | Comma-separated role IDs with admin powers |
| `SUDO_USER_IDS` | No | Comma-separated user IDs with admin powers |
| `LOG_CHANNEL_ID` | No | Channel for bot log messages |
| `ADMIN_CHANNEL_ID` | No | Sudo-only bot admin channel |
| `STAFF_APPROVAL_THREAD_ID` | No | Thread where `/staff request` submissions are posted |
| `STAFF_APPROVAL_PING_USER_ID` | No | User pinged on each staff request |
| `VOICE_CLEANUP_DELAY_MS` | No | ms before empty channel cleanup (default: 30000) |
| `BIRTHDAY_CHANNEL_ID` | No | Future: birthday pings (also editable at `/sudo → Settings → Channels`) |
| `CLIPS_CHANNEL_ID` | — | **Deprecated.** Auto-threading is now configured at `/sudo → Settings → Auto Threads` (DB-backed). Safe to remove from `.env`. |
| `FOOD_CHANNEL_ID` | — | **Deprecated.** Same as above. |
| `UPTIME_KUMA_PUSH_URL` | No | Push monitor URL |
| `BOT_OWNER_ID` | Yes for `/report` | Receives DM on every `/report` for review approval, plus startup pings (silent) |
| `GITHUB_TOKEN` | Yes for `/report` | Fine-grained PAT with **Issues: Read & Write** on `GITHUB_REPO` |
| `GITHUB_REPO` | Yes for `/report` | `owner/name`, e.g. `jason-tucker/squishybot` |

### 3. Apply database schema

SquishyBot uses `drizzle-kit push` — schema lives only in `src/db/schema/*.ts`, no SQL migration files in git. The Docker entrypoint runs the push automatically on every start. For local non-Docker dev:

```bash
pnpm drizzle-kit push
```

### 4. Deploy slash commands

```bash
pnpm commands:deploy
```

### 5. Start (development)

```bash
pnpm dev
```

---

## Production — `squishybot` CLI

A management CLI is included at `scripts/squishybot`. Install once:

```bash
sudo cp scripts/squishybot /usr/local/bin/squishybot
sudo chmod +x /usr/local/bin/squishybot
```

Then from anywhere:

```bash
squishybot install      # first-time setup: install systemd unit, run migrations, deploy commands, start
squishybot start        # start the bot
squishybot stop         # stop the bot
squishybot restart      # graceful restart (runs migrations first)
squishybot status       # service status
squishybot logs         # tail live logs (Ctrl+C to exit)
squishybot tail 50      # last 50 log lines
squishybot deploy       # redeploy slash commands to the guild
squishybot migrate      # run database migrations
squishybot update       # git pull + migrate + redeploy + restart
```

A weekly automatic restart runs every Tuesday at 4 AM via the
`squishybot-restart.timer` unit (installed by `squishybot install`).

### Manual restart fallback

If the CLI isn't available:
```bash
kill -TERM $(ps aux | grep "tsx.*src/index.ts" | grep -v grep | awk '{print $2}' | head -1)
sleep 5 && journalctl -u squishybot -n 10 --no-pager
```

---

## Bot permissions required

- Manage Channels
- Move Members
- Manage Roles (for permission overwrites)
- View Channels / Send Messages / Read Message History
- Use External Emojis (for Components V2)
- Privileged intents in Developer Portal: **Server Members**, **Presence Intent**, **Message Content** (the last is required for auto-thread name templating)

---

## Slash commands

Four top-level slash commands plus one right-click context menu. All responses are ephemeral.

| Command | Access | Description |
|---|---|---|
| `/voice` | Owner / Host / Sudo | Open an ephemeral copy of the control panel for the auto channel you're in |
| `/squishy` | Everyone | User-facing menu: bot status, feature explainers (Voice / Panel / Reports / Staff), profile editor button, staff-request button |
| `/sudo` | Sudo | Admin select-menu panel: Settings (sudo users, channels, voice, hubs, auto threads, games, user profiles), active channels, hubs, force cleanup, pending approvals, run reconciler, restart instructions |
| `/games` | Everyone | Pick which games you want View access + LFG pings for |
| `/play` | Everyone | LFG ping — picks the game, optional party size / when / platform / rank / message; rate-limited |
| `/report` | Everyone | Modal (Title / Type / Description / Steps) → DMs the owner with **Approve+Notify** / **Approve Silent** / **Reject+Notify** / **Reject Silent** buttons → on approve, files a GitHub issue against `GITHUB_REPO` |
| Right-click user → **Manage User** | Sudo | Roles, voice status, disconnect, staff history |

### Voice control panel (in each auto-channel text channel)

| Button | What it does |
|---|---|
| ✏️ **Rename** | Modal to set a custom name |
| 🔒 **Lock** / 🔓 **Unlock** | Toggle Connect on `@everyone` |
| 👑 **Hosts** | One panel listing each member with their current rank emoji: 👑 host · 🛡️ sudo · 👤 member. Click any name to toggle their host status. |
| 📋 **Templates** | Auto / Counter / Comp 5-stack / Tryhard / Chill — sets name + user limit in one click |
| 👤 **Claim** | Take ownership when the original owner has left |
| 🗑️ **Delete** | Delete both voice + text channels right away |

The persistent panel + the silent **📋 Open Panel** sticky at the bottom of the text channel are the primary interaction surfaces. Slash commands are fallback escape hatches.
