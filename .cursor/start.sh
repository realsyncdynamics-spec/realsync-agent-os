#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — Cloud Agent start phase (per boot)
# Brings up PostgreSQL + Redis and reconciles the schema.
# Idempotent: tolerates already-running services and repeat runs.
# ============================================================
set -euo pipefail

DB_USER="realsync"
DB_PASS="realsync_local_secret"
DB_NAME="realsync_dev"

echo "── Starting PostgreSQL 16 ──"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432

echo "── Starting Redis 7 ──"
redis-cli ping >/dev/null 2>&1 || sudo redis-server /etc/redis/redis.conf --daemonize yes
for _ in $(seq 1 15); do
  redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done
redis-cli ping

echo "── Reconciling role + database (idempotent) ──"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "── Applying database migrations (idempotent) ──"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}" \
  NODE_ENV=development node backend/src/db/migrate.js

echo "── Start phase complete: PostgreSQL + Redis are ready ──"
