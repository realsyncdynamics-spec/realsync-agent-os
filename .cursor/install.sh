#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — Cloud Agent install phase (idempotent)
# Durable, source-derived setup that is safe to re-run and is
# baked into the environment build snapshot:
#   1. System packages: PostgreSQL 16 + Redis 7
#   2. Node dependencies for backend + gateway (npm ci)
#   3. Local dev .env files (generated once, never overwritten)
# Runtime services + migrations are handled per-boot in start.sh.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. System packages (PostgreSQL 16 + Redis 7) ─────────────
if ! command -v psql >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
  echo "[install] Installing PostgreSQL 16 + Redis 7 ..."
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends \
    postgresql postgresql-contrib redis-server
else
  echo "[install] PostgreSQL + Redis already present — skipping apt."
fi

# ── 2. Node dependencies (reproducible) ──────────────────────
echo "[install] Installing backend dependencies ..."
( cd backend && npm ci )
echo "[install] Installing gateway dependencies ..."
( cd gateway && npm ci )

# ── 3. Local dev environment files (dev-only secrets) ────────
# Generated once and kept out of git (.gitignore). Never overwrite
# so that manual edits and later boots stay stable.
if [ ! -f backend/.env ]; then
  echo "[install] Generating backend/.env ..."
  cat > backend/.env <<EOF
NODE_ENV=development
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgresql://realsync:realsync_local_secret@localhost:5432/realsync_dev
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
AGENT_INTERNAL_KEY=$(openssl rand -hex 24)
GATEWAY_SECRET=$(openssl rand -hex 24)
INTERNAL_HEALTH_KEY=$(openssl rand -hex 24)
ENABLE_WORKERS=true
OPENCLAW_URL=http://localhost:8443
FRONTEND_URL=*
COMPANY_NAME=RealSync Dynamics
APP_URL=http://localhost:8080
EOF
else
  echo "[install] backend/.env exists — leaving untouched."
fi

if [ ! -f gateway/.env ]; then
  echo "[install] Generating gateway/.env ..."
  cat > gateway/.env <<EOF
NODE_ENV=development
PORT=8443
LOG_LEVEL=info
GATEWAY_ID=gateway-dev-01
GATEWAY_API_KEY=$(openssl rand -hex 24)
SCRIPTS_DIR=${REPO_ROOT}/scripts
ALLOWED_SCRIPT_EXTENSIONS=.sh,.ps1,.py
EOF
else
  echo "[install] gateway/.env exists — leaving untouched."
fi

echo "[install] Done."
