# SquishyBot — Deployment Guide

## Overview

| Environment | How to run |
|---|---|
| **Local dev** | `pnpm dev` (tsx, hot reload, local Postgres) |
| **Any server** | `docker compose up -d` (one command, pulls from GHCR) |
| **CI/CD** | Push to `main` → GitHub Actions builds image → pushes to GHCR → VPS pulls |
| **Auto-deploy** | [watchtower](https://github.com/nicholas-fedor/watchtower) on the VPS polls the `:latest` tag (~30s) and restarts the container when its digest changes |

> **Why Docker?** The VPS has ~900 MB free RAM and cannot compile TypeScript.
> The GitHub Actions runner has 7 GB RAM and builds the image there.
> The VPS only pulls and runs a pre-built image — zero compilation on the server.

---

## One-Command Deployment (any server with Docker)

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/squishybot.git
cd squishybot

# 2. Configure environment
cp .env.example .env
nano .env    # fill in all required values (see .env.example for guidance)

# 3. Start everything (pulls image from GHCR, starts Postgres, runs committed migrations, starts bot)
BOT_IMAGE=ghcr.io/YOUR_GITHUB_USERNAME/squishybot:latest docker compose up -d
```

Or if you want to build locally (requires enough RAM for TypeScript compilation):
```bash
docker compose up -d --build
```

**Works on:** Ubuntu, Debian, any Linux with Docker, Unraid (via Docker Compose Manager plugin)

---

## Local Development

```bash
# Install dependencies
pnpm install

# Copy and fill in env (for local dev, use localhost DATABASE_URL)
cp .env.example .env
# Set DATABASE_URL=postgresql://squishybot:squishybot_dev@localhost:5432/squishybot

# Start local Postgres (optional — uses existing if running)
docker compose up -d db

# Run bot in dev mode (hot reload)
pnpm dev
```

---

## GitHub Secrets (required once per repo)

Go to **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | `botuser` |
| `VPS_SSH_KEY` | Private SSH key contents (see below) |
| `PROJECT_DIR` | `/home/botuser/projects/squishybot` |
| `DISCORD_DEPLOY_WEBHOOK` | Discord webhook URL for deploy notifications |
| `DISCORD_BOT_TOKEN` | Bot token (used to register slash commands) |
| `DISCORD_CLIENT_ID` | Application/client ID |
| `GUILD_ID` | Target Discord guild ID |

> **GHCR authentication**: the workflow uses the automatic `GITHUB_TOKEN` — no extra secret needed.

> **Schema-sync workflow**: `.github/workflows/notify-panel-schema-change.yml` fires a `repository_dispatch` at `jason-tucker/botpanel` whenever a push to `main` touches `src/db/schema/**`, so botpanel can re-vendor the Drizzle schemas. It needs its own secret, **not** part of the table above:
>
> | Secret | Value |
> |---|---|
> | `BOTPANEL_DISPATCH_PAT` | Fine-grained PAT with `repository_dispatch` access to `jason-tucker/botpanel` |

### Generating a deploy SSH key

```bash
# On your local machine
ssh-keygen -t ed25519 -C "squishybot-deploy" -f ~/.ssh/squishybot_deploy
# Leave passphrase empty

# Add public key to VPS
ssh-copy-id -i ~/.ssh/squishybot_deploy.pub botuser@YOUR_VPS_IP

# Paste contents of ~/.ssh/squishybot_deploy into the VPS_SSH_KEY secret
cat ~/.ssh/squishybot_deploy
```

---

## One-Time VPS Setup

### 1. Install Docker (if needed)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker botuser
# Log out and back in for group to take effect
```

### 2. Clone the repo on VPS

```bash
cd /home/botuser/projects
git clone https://github.com/YOUR_USERNAME/squishybot.git
```

### 3. Create `.env` on VPS

```bash
cp /home/botuser/projects/squishybot/.env.example /home/botuser/projects/squishybot/.env
nano /home/botuser/projects/squishybot/.env
# Set POSTGRES_PASSWORD, DISCORD_BOT_TOKEN, GUILD_ID, and all other required values
# Set BOT_IMAGE=ghcr.io/YOUR_GITHUB_USERNAME/squishybot:latest
```

### 4. Start for the first time

```bash
cd /home/botuser/projects/squishybot
docker compose up -d
```

Postgres starts first (health-checked), then squishybot starts and applies committed SQL migrations automatically via `node dist/db/migrate.js`.

### 5. Verify

```bash
docker compose ps
docker compose logs squishybot --tail=20
```

---

## Schema Management (committed forward-only migrations)

SquishyBot uses committed SQL migration files, applied by `drizzle-orm`'s migrate runner at container start. This means:

- **SQL migration files are committed to git** under `src/db/migrations/`
- On every container start, `node dist/db/migrate.js` applies any unapplied migrations forward-only and fails closed (a bad migration aborts startup rather than silently corrupting data)
- Adding a new column: edit `src/db/schema/*.ts` → run `pnpm db:generate` → inspect the generated `.sql` → commit both with the schema change → push to main → redeploy → done
- Dropping a column: generate and inspect the migration carefully; data is lost on apply
- `drizzle-kit push` is **for throwaway local DBs only** — never run it against the shared production database

---

## Deploying a New Version

Just push to `main`. The workflow handles everything automatically:
1. Builds Docker image (TypeScript compiles on GitHub's servers)
2. Pushes image to GHCR
3. Registers slash commands in Discord
4. SSHs to VPS: pulls new image, restarts container
5. Sends Discord notification

> The container carries the `com.centurylinklabs.watchtower.enable="true"` label, so **watchtower** on the VPS also pulls the new `:latest` digest and restarts the bot on its own poll cycle (~30s) — the SSH step in step 4 is a belt-and-suspenders fast path, not the only deploy mechanism.

---

## Checking Container Status

```bash
# On VPS
docker compose ps
docker compose logs squishybot -f          # live logs
docker compose logs squishybot --tail=50   # last 50 lines
```

---

## Rollback

```bash
# On VPS — run a specific previous image
BOT_IMAGE=ghcr.io/YOUR_USERNAME/squishybot:sha-<previous_sha> docker compose up -d

# Find previous SHAs in GitHub: Actions → the deploy run → Docker metadata step
```

---

## Updating docker-compose.yml or .env on VPS

The `git reset --hard origin/main` in the workflow updates `docker-compose.yml` automatically. For `.env` changes, edit the file on the VPS manually:

```bash
nano /home/botuser/projects/squishybot/.env
docker compose up -d   # picks up new env vars
```

---

## Unraid Deployment

1. Install the **Docker Compose Manager** plugin from Community Applications
2. Add a new compose stack pointing to `/home/botuser/projects/squishybot/docker-compose.yml`
3. Create `.env` in the same directory
4. Start the stack

Or use Unraid's terminal and run `docker compose up -d` manually.

---

## Rotating the Discord Deploy Webhook

1. Discord channel → Edit → Integrations → Webhooks → delete old or create new
2. Update `DISCORD_DEPLOY_WEBHOOK` secret in GitHub repo settings
3. No code changes required

---

## Making the GHCR Image Public (for easier new-server deploys)

GitHub repo → **Packages → squishybot → Package settings → Change visibility → Public**

This lets any server pull the image without authenticating:
```bash
docker pull ghcr.io/YOUR_USERNAME/squishybot:latest
```
