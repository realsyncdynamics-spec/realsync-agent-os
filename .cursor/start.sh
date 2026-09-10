#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — Cloud Agent start phase (per-boot)
# Reconciles runtime state on every boot. Idempotent and
# tolerant of already-running services. Returns after the
# stack is ready; the API + gateway processes run as terminals.
#   1. Start PostgreSQL 16 + wait for readiness
#   2. Start Redis 7 + wait for readiness
#   3. Ensure realsync role + realsync_dev database exist
#   4. Apply schema + migrations (idempotent runner)
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 1. PostgreSQL ────────────────────────────────────────────
echo "[start] Starting PostgreSQL 16 ..."
sudo pg_ctlcluster 16 main start >/dev/null 2>&1 || true
ready=0
for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 -q; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "[start] ERROR: PostgreSQL did not become ready on :5432" >&2
  exit 1
fi
echo "[start] PostgreSQL ready."

# ── 2. Redis ─────────────────────────────────────────────────
echo "[start] Starting Redis 7 ..."
if ! redis-cli ping >/dev/null 2>&1; then
  sudo redis-server --daemonize yes --dir /var/lib/redis --appendonly no
fi
ready=0
for _ in $(seq 1 15); do
  if redis-cli ping >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "[start] ERROR: Redis did not become ready on :6379" >&2
  exit 1
fi
echo "[start] Redis ready."

# ── 3. Role + database (idempotent) ──────────────────────────
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='realsync'" | grep -q 1; then
  echo "[start] Creating role 'realsync' ..."
  sudo -u postgres psql -c "CREATE ROLE realsync LOGIN PASSWORD 'realsync_local_secret';"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='realsync_dev'" | grep -q 1; then
  echo "[start] Creating database 'realsync_dev' ..."
  sudo -u postgres createdb -O realsync realsync_dev
fi

# ── 4. Schema + migrations (idempotent runner) ───────────────
echo "[start] Applying schema + migrations ..."
( cd backend && node src/db/migrate.js )

echo "[start] Stack ready — backend and gateway launch as terminals."
