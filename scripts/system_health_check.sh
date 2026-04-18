#!/usr/bin/env bash
# system_health_check.sh
# OpenClaw Script Template — System Health Check
# Output: JSON { cpu_percent, ram_used_gb, ram_total_gb, disk_used_percent,
#                services, recent_errors }
# Usage:  ./system_health_check.sh [--verbose]
# Exit:   0 = success, 1 = partial failure, 2 = critical failure

set -euo pipefail

# ── Dependencies check ────────────────────────────────────────────────────────
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo >&2 "Required command not found: $1"; exit 2; }
}
require_cmd awk
require_cmd df
require_cmd free
require_cmd top
require_cmd systemctl

# ── CPU % (1-second snapshot via /proc/stat) ──────────────────────────────────
get_cpu_percent() {
  local cpu1 cpu2
  cpu1=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)
  sleep 1
  cpu2=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat)

  local total1 idle1 total2 idle2
  total1=$(echo "$cpu1" | awk '{print $1}')
  idle1=$(echo  "$cpu1" | awk '{print $2}')
  total2=$(echo "$cpu2" | awk '{print $1}')
  idle2=$(echo  "$cpu2" | awk '{print $2}')

  awk -v t1="$total1" -v i1="$idle1" -v t2="$total2" -v i2="$idle2" \
    'BEGIN { dt=t2-t1; di=i2-i1; printf "%.1f", (dt-di)/dt*100 }'
}

# ── RAM (GiB) ─────────────────────────────────────────────────────────────────
get_ram() {
  free -b | awk '/^Mem:/ {
    used_gb  = ($2 - $7) / 1073741824;
    total_gb = $2 / 1073741824;
    printf "%.2f %.2f", used_gb, total_gb
  }'
}

# ── Disk (root partition) ─────────────────────────────────────────────────────
get_disk_percent() {
  df -h / | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

# ── Systemd services status ───────────────────────────────────────────────────
get_services() {
  local services=("nginx" "postgresql" "docker")
  local json_arr="["
  local first=true

  for svc in "${services[@]}"; do
    if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${svc}.service"; then
      local status
      status=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
      [[ "$first" == true ]] && first=false || json_arr+=","
      json_arr+="{\"name\":\"${svc}\",\"status\":\"${status}\"}"
    fi
  done

  json_arr+="]"
  echo "$json_arr"
}

# ── Recent errors from syslog ─────────────────────────────────────────────────
get_recent_errors() {
  local log_file="/var/log/syslog"
  [[ ! -f "$log_file" ]] && log_file="/var/log/messages"
  [[ ! -f "$log_file" ]] && { echo "[]"; return; }

  local json_arr="["
  local first=true
  local count=0

  while IFS= read -r line; do
    [[ $count -ge 20 ]] && break
    # Escape double-quotes and backslashes for JSON
    local escaped="${line//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    [[ "$first" == true ]] && first=false || json_arr+=","
    json_arr+="\"${escaped}\""
    ((count++)) || true
  done < <(grep -i 'error\|critical\|fail' "$log_file" | tail -20)

  json_arr+="]"
  echo "$json_arr"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  local cpu_percent ram_info ram_used ram_total disk_percent services recent_errors

  cpu_percent=$(get_cpu_percent)
  ram_info=$(get_ram)
  ram_used=$(echo  "$ram_info" | awk '{print $1}')
  ram_total=$(echo "$ram_info" | awk '{print $2}')
  disk_percent=$(get_disk_percent)
  services=$(get_services)
  recent_errors=$(get_recent_errors)

  # Build JSON output
  cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "cpu_percent": ${cpu_percent},
  "ram_used_gb": ${ram_used},
  "ram_total_gb": ${ram_total},
  "disk_used_percent": ${disk_percent},
  "services": ${services},
  "recent_errors": ${recent_errors}
}
EOF
}

main "$@"
