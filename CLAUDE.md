# SquishyBot — AI Coding Instructions

See `/home/botuser/projects/claude-all.md` for VPS constraints, systemd setup,
Discord.js patterns, Components V2, and database conventions that apply to all bots.

Bot-specific details go below.

---

## What this bot does

<!-- Describe SquishyBot's purpose and features here as they are built -->

## Commands

<!-- Document slash commands here as they are added -->

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `NODE_ENV` | No | `development` or `production` |
| `UPTIME_KUMA_PUSH_URL` | No | Push monitor URL |

## Bot restart (production)

```bash
kill -TERM $(ps aux | grep "tsx.*src/index.ts" | grep -v grep | awk '{print $2}' | head -1)
sleep 5 && journalctl -u squishybot -n 10 --no-pager
```

## Deploy slash commands

```bash
pnpm commands:deploy
```
