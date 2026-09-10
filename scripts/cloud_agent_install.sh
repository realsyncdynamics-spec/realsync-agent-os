#!/usr/bin/env bash
# ============================================================
# Cloud Agent — install phase (idempotent dependency refresh)
# Runs after the repository is checked out. Must terminate.
#
# Installs the stable system services (Postgres 16 + Redis 7) if
# they are not already present, then refreshes backend Node deps.
# Per-boot service startup + migrations live in cloud_agent_start.sh.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── System packages (idempotent) ────────────────────────────
if ! command -v pg_ctlcluster >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
  echo "[cloud_agent_install] Installing system packages (PostgreSQL 16 + Redis)…"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    postgresql postgresql-contrib redis-server
else
  echo "[cloud_agent_install] System packages already present — skipping apt."
fi

# ── Backend Node dependencies ───────────────────────────────
echo "[cloud_agent_install] Installing backend dependencies (npm ci)…"
cd "$REPO_ROOT/backend"
npm ci

echo "[cloud_agent_install] Done."
