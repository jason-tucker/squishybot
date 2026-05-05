# SquishyBot — Deployment Guide

## Overview

- **Local development**: VSCode on your PC, run `pnpm dev`
- **Deployments**: push to `main` → GitHub Actions builds and deploys to VPS automatically
- **VPS role**: runs the compiled bot via systemd; no development happens there

> **VPS constraint**: The VPS has ~900 MB free RAM. TypeScript compilation (`tsc`) OOMs it.
> The build always runs on the GitHub Actions runner, never on the VPS.

---

## Local Development

```bash
# Install dependencies
pnpm install

# Copy and fill in env
cp .env.example .env

# Run in dev mode (tsx, hot reload)
pnpm dev
```

---

## Deployment Flow (automatic)

1. Commit and push to `main`
2. GitHub Actions runs `.github/workflows/deploy.yml`:
   - Installs deps on the runner
   - Compiles TypeScript → `dist/`
   - Registers slash commands from `dist/`
   - SSHs into VPS: `git pull`, `pnpm install`, `db:migrate`
   - Uploads `dist/` to VPS via SCP
   - SSHs into VPS: `systemctl restart squishybot`, verifies active
   - Sends Discord webhook notification (success or failure)

---

## One-Time VPS Setup

### 1. Install the systemd service

```bash
sudo cp /home/botuser/projects/squishybot/deploy/systemd/squishybot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable squishybot
sudo systemctl start squishybot
```

Verify the `ExecStart` path matches your node binary:
```bash
which node
# Should be /usr/bin/node — if not, edit squishybot.service before copying
```

### 2. Configure passwordless sudo for botuser

The deploy workflow needs to restart the service without a password prompt.

First, find your `systemctl` path:
```bash
which systemctl
# /usr/bin/systemctl  (use this path below)
```

Then add the sudoers rule:
```bash
sudo visudo
```

Add this line (replace `/usr/bin/systemctl` with the actual path if different):
```
botuser ALL=NOPASSWD: /usr/bin/systemctl stop squishybot, /usr/bin/systemctl start squishybot, /usr/bin/systemctl restart squishybot, /usr/bin/systemctl status squishybot, /usr/bin/systemctl is-active squishybot
```

### 3. Add bot's .env on VPS

```bash
cp /home/botuser/projects/squishybot/.env.example /home/botuser/projects/squishybot/.env
nano /home/botuser/projects/squishybot/.env
# Fill in all real values
```

### 4. Run initial database migration on VPS

```bash
cd /home/botuser/projects/squishybot
pnpm install --frozen-lockfile
pnpm run db:migrate
```

---

## GitHub Secrets Setup

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `VPS_HOST` | Your VPS IP address or hostname |
| `VPS_USER` | `botuser` |
| `VPS_SSH_KEY` | Contents of your **private** SSH key (see below) |
| `PROJECT_DIR` | `/home/botuser/projects/squishybot` |
| `DISCORD_DEPLOY_WEBHOOK` | Discord webhook URL for deploy notifications |
| `DISCORD_BOT_TOKEN` | Bot token (used to register slash commands on the runner) |
| `DISCORD_CLIENT_ID` | Application/client ID |
| `GUILD_ID` | Target Discord guild ID |

### Generating a deploy SSH key (if needed)

On your local machine:
```bash
ssh-keygen -t ed25519 -C "squishybot-deploy" -f ~/.ssh/squishybot_deploy
# No passphrase — Actions can't type one
```

Add the **public** key to the VPS:
```bash
ssh-copy-id -i ~/.ssh/squishybot_deploy.pub botuser@YOUR_VPS_IP
```

Paste the contents of `~/.ssh/squishybot_deploy` (private key) into the `VPS_SSH_KEY` secret.

---

## Manual Deployment

To trigger a deploy without pushing code:

GitHub repo → **Actions → Deploy SquishyBot → Run workflow → Run workflow**

---

## Checking Service Status (VPS)

```bash
# Service status
squishybot status
# or
sudo systemctl status squishybot

# Live logs
squishybot logs
# or
journalctl -u squishybot -f

# Last 50 lines
squishybot tail 50
```

---

## Rollback

To roll back to a previous commit:

```bash
# On VPS
cd /home/botuser/projects/squishybot
git log --oneline -10          # find the commit SHA you want
git reset --hard <SHA>
pnpm run db:migrate            # safe to re-run
sudo systemctl restart squishybot
systemctl is-active squishybot
```

You'll also need to re-upload the dist for that commit. Either:
- Revert the commit on GitHub and let Actions redeploy, or
- Build locally and rsync manually:
  ```bash
  pnpm run build
  rsync -avz --delete dist/ botuser@YOUR_VPS_IP:/home/botuser/projects/squishybot/dist/
  ```

---

## Rotating the Discord Deploy Webhook

1. Go to the Discord channel → Edit Channel → Integrations → Webhooks
2. Delete the old webhook or click **Copy URL** on the new one
3. Update the `DISCORD_DEPLOY_WEBHOOK` secret in GitHub
4. No code changes required

---

## Rotating the Bot Token

1. Discord Developer Portal → your app → Bot → Reset Token
2. Update `DISCORD_BOT_TOKEN` in:
   - GitHub secret `DISCORD_BOT_TOKEN`
   - VPS `.env` file: `nano /home/botuser/projects/squishybot/.env`
3. Restart: `squishybot restart`

---

## Verifying a Deployment

After a push to `main`:
1. GitHub repo → **Actions** → confirm the latest run is green
2. Check Discord deploy channel for the success webhook notification
3. On VPS: `squishybot status` should show `active (running)`
4. In Discord: run `/squishy status` — should respond with current uptime
