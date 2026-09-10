#!/usr/bin/env bash
# ============================================================
# Cloud Agent — start phase (idempotent per-boot reconciliation)
# Brings up Postgres 16 + Redis 7, ensures the dev role/database
# exist, writes a local backend/.env if missing, and applies
# database migrations. Safe to run repeatedly.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Postgres 16 ─────────────────────────────────────────────
echo "[cloud_agent_start] Starting Postgres…"
sudo pg_ctlcluster 16 main start 2>/dev/null \
  || sudo service postgresql start 2>/dev/null \
  || true

# ── Redis 7 ─────────────────────────────────────────────────
echo "[cloud_agent_start] Starting Redis…"
sudo service redis-server start 2>/dev/null \
  || sudo redis-server --daemonize yes 2>/dev/null \
  || true

# ── Wait for Postgres to accept connections ─────────────────
for _ in $(seq 1 30); do
  pg_isready -h localhost -q && break || sleep 1
done

# ── Dev role + database (idempotent) ────────────────────────
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='realsync'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE realsync LOGIN PASSWORD 'realsync_local_secret'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='realsync_dev'" | grep -q 1 \
  || sudo -u postgres createdb -O realsync realsync_dev

# ── backend/.env (generate once with random dev secrets) ────
ENV_FILE="$REPO_ROOT/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[cloud_agent_start] Generating backend/.env with local dev secrets…"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=development
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgresql://realsync:realsync_local_secret@localhost:5432/realsync_dev
REDIS_URL=redis://localhost:6379
JWT_SECRET=$(openssl rand -hex 64)
JWT_REFRESH_SECRET=$(openssl rand -hex 64)
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
AGENT_INTERNAL_KEY=$(openssl rand -hex 32)
GATEWAY_SECRET=$(openssl rand -hex 32)
INTERNAL_HEALTH_KEY=$(openssl rand -hex 32)
ENABLE_WORKERS=true
FRONTEND_URL=*
COMPANY_NAME=RealSync Dynamics
EOF
fi

# ── Database migrations (idempotent) ────────────────────────
echo "[cloud_agent_start] Applying database migrations…"
cd "$REPO_ROOT/backend"
npm run migrate

echo "[cloud_agent_start] Ready — Postgres + Redis up, schema migrated."
