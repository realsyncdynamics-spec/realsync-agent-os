#!/usr/bin/env bash
# ============================================================
# Cloud Agent — install phase (idempotent dependency refresh)
# Runs after the repository is checked out. Must terminate.
# System services (Postgres/Redis) are handled in cloud_agent_start.sh.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[cloud_agent_install] Installing backend dependencies (npm ci)…"
cd "$REPO_ROOT/backend"
npm ci

echo "[cloud_agent_install] Done."
