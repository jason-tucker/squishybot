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

### Planned Features

- Game role and channel management with opt-in ping system
- Birthday pings
- Automatic threads in clips/food channels
- Sudo user management panel

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
| `AUTO_VOICE_CATEGORY_ID` | Yes | Category for hubs and auto channels |
| `HUB_CHANNEL_IDS` | Yes | Comma-separated hub voice channel IDs |
| `SUDO_ROLE_IDS` | No | Comma-separated role IDs with admin powers |
| `SUDO_USER_IDS` | No | Comma-separated user IDs with admin powers |
| `LOG_CHANNEL_ID` | No | Channel for bot log messages |
| `ADMIN_CHANNEL_ID` | No | Sudo-only bot admin channel |
| `STAFF_APPROVAL_THREAD_ID` | No | Thread where `/staff request` submissions are posted |
| `STAFF_APPROVAL_PING_USER_ID` | No | User pinged on each staff request |
| `VOICE_CLEANUP_DELAY_MS` | No | ms before empty channel cleanup (default: 30000) |
| `BIRTHDAY_CHANNEL_ID` | No | Future: birthday pings |
| `CLIPS_CHANNEL_ID` | No | Future: auto-thread on clips |
| `FOOD_CHANNEL_ID` | No | Future: auto-thread on food |
| `UPTIME_KUMA_PUSH_URL` | No | Push monitor URL |

### 3. Run database migrations

```bash
pnpm db:migrate
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
- Privileged intents in Developer Portal: **Server Members** and **Voice Activity** (Voice State)

---

## Slash commands

| Command | Access | Description |
|---|---|---|
| `/help` | Everyone | List available commands (sudo section appears for sudo users) |
| `/squishy status` | Everyone | Bot status, uptime, active channel count |
| `/squishy repair` | Sudo | Manually run the startup reconciler |
| `/voice panel` | Owner/Host/Sudo | Open or refresh the control panel for your active voice channel |
| `/voice claim` | Voice members | Claim ownership of an unclaimed auto channel |
| `/voice delete` | Owner/Host/Sudo | Delete your auto voice channel |
| `/staff request` | Everyone | Submit a staff role request to the approval thread |
| `/sudo channels` | Sudo | List active auto channels |
| `/sudo hubs` | Sudo | List managed hub channels |
| `/sudo cleanup` | Sudo | Force cleanup of empty/orphaned channels |
| `/sudo approvals` | Sudo | List pending staff approvals |
| `/sudo restart` | Sudo | Show terminal restart instructions |

The control panel inside an auto text channel (Components V2) is the primary interface —
slash commands are fallback escape hatches.
