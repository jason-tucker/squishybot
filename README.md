# SquishyBot

A multipurpose Discord bot for a single server. Built with discord.js v14, TypeScript, PostgreSQL, and Drizzle ORM.

## Features

### Auto Voice Channels (Phase 1–5)

- Join a **hub** voice channel → the hub converts into your personal voice channel (you stay in it)
- A replacement hub is immediately created
- An attached **text channel** appears, visible only to users in the voice channel + sudo users
- A persistent **control panel** message lets you rename, lock, add/remove hosts, or delete the channel
- When the channel becomes empty, both voice + text channels are cleaned up automatically
- Bot repairs itself on restart (reconciler recovers orphaned channels and missing hubs)

### Planned Features

- Staff role request and approval workflow
- Game role and channel management with opt-in ping system
- Birthday pings
- Automatic threads in configured channels
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

Required env vars:
- `DISCORD_BOT_TOKEN` — from Discord Developer Portal
- `DISCORD_CLIENT_ID` — application ID
- `DATABASE_URL` — PostgreSQL connection string
- `GUILD_ID` — your server ID
- `AUTO_VOICE_CATEGORY_ID` — category where voice channels live
- `HUB_CHANNEL_IDS` — comma-separated IDs of hub voice channels

Optional but useful:
- `SUDO_ROLE_IDS` / `SUDO_USER_IDS` — bot admins
- `LOG_CHANNEL_ID` — channel for bot log messages
- `VOICE_CLEANUP_DELAY_MS` — ms before empty channel cleanup (default: 30000)

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

## Production (systemd)

```ini
[Unit]
Description=SquishyBot
After=network-online.target

[Service]
Type=simple
User=botuser
WorkingDirectory=/home/botuser/projects/squishybot
ExecStart=/home/botuser/projects/squishybot/node_modules/.bin/tsx src/index.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=squishybot

[Install]
WantedBy=multi-user.target
```

Restart after code changes:
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

---

## Slash commands

| Command | Description |
|---|---|
| `/squishy status` | Bot status and active channel count |
| `/squishy repair` | Manually run the startup reconciler (sudo only) |
| `/voice panel` | Open the control panel for your active voice channel |
| `/voice claim` | Claim ownership of an unclaimed auto channel |
| `/voice delete` | Delete your auto voice channel |
