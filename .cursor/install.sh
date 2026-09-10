#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — Cloud Agent install phase (idempotent)
# Installs system services + Node deps, provisions the dev DB,
# and applies migrations. Safe to run repeatedly.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DB_USER="realsync"
DB_PASS="realsync_local_secret"
DB_NAME="realsync_dev"

echo "── Installing system packages (PostgreSQL 16 + Redis 7) ──"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  postgresql-16 postgresql-client-16 redis-server

echo "── Installing Node dependencies ──"
( cd backend && npm ci )
( cd gateway && npm ci )

echo "── Starting PostgreSQL to provision the dev database ──"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done

echo "── Ensuring role + database exist ──"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

echo "── Applying database migrations ──"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}" \
  NODE_ENV=development node backend/src/db/migrate.js

echo "── Install phase complete ──"
