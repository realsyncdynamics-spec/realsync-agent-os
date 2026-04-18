#!/usr/bin/env bash
# log_anomaly_scan.sh
# OpenClaw Script Template — Log Anomaly Scanner
# Scans /var/log/*.log for ERROR/CRITICAL/FATAL patterns in the last 24 hours.
# Output: JSON { scanned_files, total_errors, top_errors }
# Exit:   0 = success, 1 = no log files found

set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log}"
HOURS="${HOURS:-24}"
PATTERNS="${PATTERNS:-ERROR|CRITICAL|FATAL|PANIC|EMERG}"

# ── Timestamp boundary: 24h ago ───────────────────────────────────────────────
CUTOFF_EPOCH=$(date -d "${HOURS} hours ago" +%s 2>/dev/null \
  || date -v "-${HOURS}H" +%s 2>/dev/null \
  || echo 0)

# ── Find relevant log files ───────────────────────────────────────────────────
mapfile -t LOG_FILES < <(find "$LOG_DIR" -maxdepth 2 -name "*.log" -readable 2>/dev/null)

if [[ ${#LOG_FILES[@]} -eq 0 ]]; then
  echo '{"scanned_files":0,"total_errors":0,"top_errors":[]}'
  exit 1
fi

# ── Temp workspace ────────────────────────────────────────────────────────────
TMP_HITS=$(mktemp)
trap 'rm -f "$TMP_HITS"' EXIT

total_errors=0
scanned=0

for log_file in "${LOG_FILES[@]}"; do
  [[ -f "$log_file" ]] || continue
  ((scanned++)) || true

  while IFS= read -r line; do
    # Try to extract timestamp from common log formats:
    # 2024-01-15 14:23:01 ...  or  Jan 15 14:23:01 ...
    local_ts=""
    if [[ "$line" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}) ]]; then
      local_ts="${BASH_REMATCH[1]}"
    fi

    # Filter by time if timestamp found
    if [[ -n "$local_ts" && "$CUTOFF_EPOCH" -gt 0 ]]; then
      line_epoch=$(date -d "$local_ts" +%s 2>/dev/null || echo 0)
      [[ "$line_epoch" -lt "$CUTOFF_EPOCH" ]] && continue
    fi

    # Extract matching pattern
    matched=$(echo "$line" | grep -oE "$PATTERNS" | head -1 || true)
    [[ -z "$matched" ]] && continue

    echo "${matched}|||${log_file}|||${local_ts:-unknown}" >> "$TMP_HITS"
    ((total_errors++)) || true
  done < <(grep -iE "$PATTERNS" "$log_file" 2>/dev/null || true)
done

# ── Aggregate top errors ──────────────────────────────────────────────────────
build_top_errors() {
  [[ ! -s "$TMP_HITS" ]] && echo "[]" && return

  # Count occurrences per (pattern, file) pair
  declare -A counts
  declare -A last_seen
  declare -A file_map

  while IFS='|||' read -r pattern file ts; do
    key="${pattern}::${file}"
    counts[$key]=$(( ${counts[$key]:-0} + 1 ))
    last_seen[$key]="$ts"
    file_map[$key]="$file"
  done < "$TMP_HITS"

  # Sort by count desc, take top 10
  local sorted
  sorted=$(for key in "${!counts[@]}"; do
    echo "${counts[$key]} $key"
  done | sort -rn | head -10)

  local json_arr="["
  local first=true

  while read -r count key; do
    local pattern file ts
    pattern="${key%%::*}"
    file="${key##*::}"
    ts="${last_seen[$key]:-unknown}"

    [[ "$first" == true ]] && first=false || json_arr+=","
    json_arr+="{\"pattern\":\"${pattern}\",\"count\":${count},\"last_seen\":\"${ts}\",\"file\":\"${file}\"}"
  done <<< "$sorted"

  json_arr+="]"
  echo "$json_arr"
}

TOP_ERRORS=$(build_top_errors)

cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "scan_window_hours": ${HOURS},
  "scanned_files": ${scanned},
  "total_errors": ${total_errors},
  "top_errors": ${TOP_ERRORS}
}
EOF
