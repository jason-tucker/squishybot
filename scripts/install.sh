#!/usr/bin/env bash
# SquishyBot — VPS install/update script
#
# Usage (after cloning the repo):
#   ./scripts/install.sh
#
# Or one-shot (replace OWNER):
#   GITHUB_OWNER=OWNER bash <(curl -fsSL https://raw.githubusercontent.com/OWNER/squishybot/main/scripts/install.sh)
#
# What this script does:
#   1. Checks Docker + Docker Compose are installed (helps install if not)
#   2. Clones or updates the repo
#   3. Creates .env from .env.example (prompts you to edit)
#   4. Pulls the latest GHCR image
#   5. Starts the bot + Postgres via docker compose
#   6. Verifies the container is running

set -Eeuo pipefail

BOT_NAME="squishybot"
GITHUB_OWNER="${GITHUB_OWNER:-}"
BRANCH="${BRANCH:-main}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/projects/$BOT_NAME}"
MIN_DOCKER_MAJOR=24

# ── Colors ────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
    GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
else
    GREEN=''; YELLOW=''; RED=''; BLUE=''; NC=''
fi
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
info() { printf "${BLUE}▶${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*" >&2; }

# ── Step 1: Docker ────────────────────────────────────────────────────────────
info "Checking Docker..."
if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed."
    cat <<EOF
Install Docker first:
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker \$USER
    newgrp docker
Then rerun this script.
EOF
    exit 1
fi

DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "")
if [ -z "$DOCKER_VER" ]; then
    err "Docker is installed but the daemon is not accessible."
    echo "  Try: sudo systemctl start docker"
    echo "  Or check group membership: groups | grep docker"
    exit 1
fi

DOCKER_MAJOR=$(echo "$DOCKER_VER" | cut -d. -f1)
if [ "$DOCKER_MAJOR" -lt "$MIN_DOCKER_MAJOR" ]; then
    warn "Docker $DOCKER_VER is older than recommended ($MIN_DOCKER_MAJOR.x+). Continuing anyway."
else
    ok "Docker $DOCKER_VER"
fi

# ── Step 2: Docker Compose v2 ─────────────────────────────────────────────────
if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 plugin is not installed."
    echo "  On Debian/Ubuntu: sudo apt install -y docker-compose-plugin"
    echo "  On other systems: see https://docs.docker.com/compose/install/"
    exit 1
fi
COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "?")
ok "Docker Compose $COMPOSE_VER"

# ── Step 3: Clone or update repo ──────────────────────────────────────────────
if [ ! -d "$PROJECT_DIR" ]; then
    if [ -z "$GITHUB_OWNER" ]; then
        read -rp "GitHub owner/username for $BOT_NAME: " GITHUB_OWNER
    fi
    info "Cloning $BOT_NAME to $PROJECT_DIR..."
    mkdir -p "$(dirname "$PROJECT_DIR")"
    git clone -b "$BRANCH" "https://github.com/$GITHUB_OWNER/$BOT_NAME.git" "$PROJECT_DIR"
else
    info "Updating $PROJECT_DIR..."
    cd "$PROJECT_DIR"
    git fetch --all
    git reset --hard "origin/$BRANCH"
fi

cd "$PROJECT_DIR"

# Detect GitHub owner from remote if not set
if [ -z "$GITHUB_OWNER" ]; then
    GITHUB_OWNER=$(git config --get remote.origin.url | sed -E 's|.*[:/]([^/]+)/[^/]+\.git|\1|')
fi
GHCR_IMAGE="ghcr.io/${GITHUB_OWNER,,}/$BOT_NAME:latest"

# ── Step 4: .env setup ────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    info "Creating .env from .env.example..."
    cp .env.example .env

    # Inject the GHCR image
    if grep -q '^BOT_IMAGE=' .env; then
        sed -i "s|^BOT_IMAGE=.*|BOT_IMAGE=$GHCR_IMAGE|" .env
    else
        echo "BOT_IMAGE=$GHCR_IMAGE" >> .env
    fi

    # Generate a strong default Postgres password if user hasn't set one
    if grep -qE '^POSTGRES_PASSWORD=(change_me|squishybot_dev|)?$' .env; then
        STRONG_PW=$(openssl rand -base64 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
        sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$STRONG_PW|" .env
        ok "Generated random POSTGRES_PASSWORD"
    fi

    warn "Edit .env now and fill in:"
    echo "    DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, GUILD_ID"
    echo "    AUTO_VOICE_CATEGORY_ID, HUB_CHANNEL_IDS"
    echo "    SUDO_USER_IDS, BOT_OWNER_ID"
    echo ""
    echo "    File: $PROJECT_DIR/.env"
    echo ""
    read -rp "Press ENTER to open .env in nano (Ctrl-O to save, Ctrl-X to exit)..."
    ${EDITOR:-nano} .env
else
    ok ".env already exists"
fi

# ── Step 5: Pull image ────────────────────────────────────────────────────────
info "Pulling Docker image: $GHCR_IMAGE"
if ! docker compose pull "$BOT_NAME" 2>&1; then
    err "Failed to pull image. Either:"
    echo "  - The image isn't published yet (push to main triggers a build), or"
    echo "  - The image is private and you need to: docker login ghcr.io"
    echo ""
    read -rp "Build locally instead? [y/N] " BUILD_LOCAL
    if [[ "$BUILD_LOCAL" =~ ^[Yy] ]]; then
        info "Building locally (will use lots of RAM)..."
        docker compose build
    else
        exit 1
    fi
fi

# ── Step 6: Start ─────────────────────────────────────────────────────────────
info "Starting $BOT_NAME and Postgres..."
docker compose up -d --remove-orphans

# ── Step 7: Verify ────────────────────────────────────────────────────────────
info "Waiting for container to be healthy..."
sleep 8

if docker compose ps "$BOT_NAME" 2>/dev/null | grep -qE "running|Up"; then
    ok "$BOT_NAME is running"
    echo ""
    docker compose ps
    echo ""
    info "Useful commands:"
    echo "    cd $PROJECT_DIR"
    echo "    docker compose logs $BOT_NAME -f       # live logs"
    echo "    docker compose logs $BOT_NAME --tail=50"
    echo "    docker compose restart $BOT_NAME       # restart"
    echo "    docker compose down                    # stop everything"
    echo ""
    ok "Setup complete."
else
    err "$BOT_NAME failed to start. Recent logs:"
    docker compose logs "$BOT_NAME" --tail=30
    exit 1
fi
