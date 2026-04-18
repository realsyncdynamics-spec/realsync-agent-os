#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — Post-Deploy Smoke Test
# Usage: bash scripts/smoke_test.sh https://SERVICE-URL
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'

pass() { echo -e "${GREEN}[✓]${RESET} $*"; }
fail() { echo -e "${RED}[✗]${RESET} $*"; FAILURES=$((FAILURES+1)); }
info() { echo -e "${YELLOW}[→]${RESET} $*"; }

SERVICE_URL="${1:?Usage: bash scripts/smoke_test.sh https://SERVICE-URL}"
SERVICE_URL="${SERVICE_URL%/}"  # trailing slash entfernen
FAILURES=0

echo -e "\n${BOLD}RealSync Agent-OS — Smoke Test${RESET}"
echo -e "Target: ${SERVICE_URL}\n"

# ── 1. Liveness ──────────────────────────────────────────────
info "1/6 Liveness check..."
RESP=$(curl -sf "${SERVICE_URL}/health" 2>/dev/null) || { fail "GET /health failed (connection error)"; RESP="{}"; }
STATUS=$(echo "${RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
EU=$(echo "${RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('eu_ai_act_compliant',''))" 2>/dev/null || echo "")

[[ "${STATUS}" == "ok" ]] && pass "Liveness: ok" || fail "Liveness: unexpected status '${STATUS}'"
[[ "${EU}" == "True" || "${EU}" == "true" ]] && pass "EU AI Act label: present" || fail "EU AI Act label: missing"

# ── 2. Readiness ─────────────────────────────────────────────
info "2/6 Readiness check..."
HTTP=$(curl -sf -o /tmp/rs_ready.json -w "%{http_code}" "${SERVICE_URL}/health/ready" 2>/dev/null || echo "000")
READY=$(python3 -c "import json; d=json.load(open('/tmp/rs_ready.json')); print(d.get('status',''))" 2>/dev/null || echo "")
DB=$(python3 -c "import json; d=json.load(open('/tmp/rs_ready.json')); print(d.get('checks',{}).get('database',{}).get('status',''))" 2>/dev/null || echo "")

[[ "${HTTP}" == "200" && "${READY}" == "ready" ]] && pass "Readiness: ready" || fail "Readiness: HTTP ${HTTP}, status '${READY}'"
[[ "${DB}" == "ok" ]] && pass "Database: connected" || fail "Database: '${DB}' — check DATABASE_URL secret"

# ── 3. Auth endpoint reachable ───────────────────────────────
info "3/6 Auth endpoint..."
HTTP=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
  "${SERVICE_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"probe@example.com","password":"WrongPass1!"}' 2>/dev/null || echo "000")
# Expect 401 (wrong password) — not 404 or 500
[[ "${HTTP}" == "401" ]] && pass "Auth endpoint: reachable (401 as expected)" \
  || fail "Auth endpoint: HTTP ${HTTP} (expected 401)"

# ── 4. 404 handler ───────────────────────────────────────────
info "4/6 404 handler (RFC 9457)..."
RESP=$(curl -sf "${SERVICE_URL}/api/nonexistent-route-xyz" \
  -H "Authorization: Bearer invalid" 2>/dev/null || echo "{}")
TYPE=$(echo "${RESP}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('type',''))" 2>/dev/null || echo "")
[[ "${TYPE}" == *"realsync.io/errors"* ]] && pass "RFC 9457 error format: correct" \
  || fail "RFC 9457 error format: type field missing or wrong"

# ── 5. Agent endpoint protected ──────────────────────────────
info "5/6 Agent auth guard..."
HTTP=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
  "${SERVICE_URL}/agent/research" \
  -H "Content-Type: application/json" \
  -d '{"action":"web_search","payload":{},"tenant_id":"test"}' 2>/dev/null || echo "000")
[[ "${HTTP}" == "401" || "${HTTP}" == "403" ]] && pass "Agent auth guard: active (HTTP ${HTTP})" \
  || fail "Agent auth guard: HTTP ${HTTP} (expected 401/403)"

# ── 6. Response time ─────────────────────────────────────────
info "6/6 Response time..."
TIME=$(curl -sf -o /dev/null -w "%{time_total}" "${SERVICE_URL}/health" 2>/dev/null || echo "99")
TIME_MS=$(python3 -c "print(int(float('${TIME}') * 1000))" 2>/dev/null || echo "9999")
[[ ${TIME_MS} -lt 2000 ]] && pass "Response time: ${TIME_MS}ms (< 2000ms)" \
  || fail "Response time: ${TIME_MS}ms (too slow — check Cloud Run cold start)"

# ── Ergebnis ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✅ Alle Tests bestanden — Service ist live!${RESET}"
  echo -e "  ${SERVICE_URL}"
else
  echo -e "${RED}${BOLD}  ❌ ${FAILURES} Test(s) fehlgeschlagen${RESET}"
  echo -e "  Logs: gcloud run services logs read realsync-backend --region europe-west1"
fi
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
exit $FAILURES
