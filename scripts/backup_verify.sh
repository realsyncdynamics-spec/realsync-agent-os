#!/usr/bin/env bash
# backup_verify.sh
# OpenClaw Script Template — Backup Verification
# Parameters (environment variables):
#   BACKUP_DIR      — path to backup directory (required)
#   MAX_AGE_HOURS   — max allowed age in hours before "stale" (default: 25)
# Output: JSON { backup_exists, latest_backup_age_hours, total_size_gb, status }
# Exit:   0 = ok, 1 = stale, 2 = missing

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-25}"

# ── Validation ────────────────────────────────────────────────────────────────
if [[ -z "$BACKUP_DIR" ]]; then
  cat <<'EOF'
{"error":"BACKUP_DIR environment variable is not set","status":"error"}
EOF
  exit 2
fi

# ── Missing directory ─────────────────────────────────────────────────────────
if [[ ! -d "$BACKUP_DIR" ]]; then
  cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backup_dir": "${BACKUP_DIR}",
  "backup_exists": false,
  "latest_backup_age_hours": null,
  "total_size_gb": 0,
  "file_count": 0,
  "status": "missing"
}
EOF
  exit 2
fi

# ── Find most recent file (any extension) ────────────────────────────────────
LATEST_FILE=$(find "$BACKUP_DIR" -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn \
  | head -1 \
  | awk '{print $2}')

if [[ -z "$LATEST_FILE" ]]; then
  # Directory exists but is empty
  cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backup_dir": "${BACKUP_DIR}",
  "backup_exists": false,
  "latest_backup_age_hours": null,
  "total_size_gb": 0,
  "file_count": 0,
  "status": "missing"
}
EOF
  exit 2
fi

# ── Calculate age ─────────────────────────────────────────────────────────────
NOW_EPOCH=$(date +%s)
FILE_EPOCH=$(stat -c '%Y' "$LATEST_FILE" 2>/dev/null \
  || stat -f '%m' "$LATEST_FILE" 2>/dev/null \
  || echo 0)

AGE_SECONDS=$(( NOW_EPOCH - FILE_EPOCH ))
AGE_HOURS=$(awk "BEGIN {printf \"%.2f\", ${AGE_SECONDS}/3600}")

# ── Total size (GiB) ─────────────────────────────────────────────────────────
TOTAL_BYTES=$(du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}' || echo 0)
TOTAL_SIZE_GB=$(awk "BEGIN {printf \"%.3f\", ${TOTAL_BYTES}/1073741824}")

# ── File count ────────────────────────────────────────────────────────────────
FILE_COUNT=$(find "$BACKUP_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')

# ── Determine status ──────────────────────────────────────────────────────────
STATUS="ok"
EXIT_CODE=0

if awk "BEGIN {exit !(${AGE_HOURS} > ${MAX_AGE_HOURS})}"; then
  STATUS="stale"
  EXIT_CODE=1
fi

# ── Output ────────────────────────────────────────────────────────────────────
LATEST_ESCAPED="${LATEST_FILE//\"/\\\"}"

cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backup_dir": "${BACKUP_DIR}",
  "backup_exists": true,
  "latest_file": "${LATEST_ESCAPED}",
  "latest_backup_age_hours": ${AGE_HOURS},
  "max_age_hours": ${MAX_AGE_HOURS},
  "total_size_gb": ${TOTAL_SIZE_GB},
  "file_count": ${FILE_COUNT},
  "status": "${STATUS}"
}
EOF

exit $EXIT_CODE
