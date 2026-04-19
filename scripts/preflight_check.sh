#!/usr/bin/env bash
# =============================================================================
# RealSync Agent-OS — Pre-Flight Check Script
# Validates the full local stack without any GCP dependency.
#
# Usage:
#   bash scripts/preflight_check.sh            # full check
#   bash scripts/preflight_check.sh --quick    # skip Docker build
#   bash scripts/preflight_check.sh --ci       # non-interactive CI mode
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ── State ────────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
WARN=0
QUICK=false
CI=false
START_TS=$(date +%s)

for arg in "$@"; do
  [[ "$arg" == "--quick" ]] && QUICK=true
  [[ "$arg" == "--ci"    ]] && CI=true
done

# ── Helpers ──────────────────────────────────────────────────────────────────
pass()  { echo -e "  ${GREEN}✔${NC}  $*"; ((PASS++));  }
fail()  { echo -e "  ${RED}✘${NC}  $*"; ((FAIL++));   }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; ((WARN++));  }
info()  { echo -e "  ${BLUE}ℹ${NC}  $*";                }
header(){ echo -e "\n${BOLD}${BLUE}══ $* ══${NC}"; }

# ── Section 1: Local Prerequisites ───────────────────────────────────────────
header "1 · Prerequisites"

check_cmd() {
  local cmd=$1 pkg=${2:-$1}
  if command -v "$cmd" &>/dev/null; then
    local ver
    ver=$("$cmd" --version 2>&1 | head -1 || true)
    pass "$cmd found  →  $ver"
  else
    fail "$cmd not found  (install: $pkg)"
  fi
}

check_cmd node   "nodejs"
check_cmd npm    "npm"
check_cmd docker "docker"
check_cmd docker "docker (compose plugin)" 2>/dev/null || \
  command -v docker-compose &>/dev/null && pass "docker-compose (standalone) found" || \
  fail "docker compose / docker-compose not found"
check_cmd git    "git"
check_cmd jq     "jq"
check_cmd curl   "curl"
check_cmd openssl "openssl"

# Node version ≥ 20
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(process.version.split('.')[0].replace('v',''))")
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    pass "Node.js major version $NODE_MAJOR ≥ 20"
  else
    fail "Node.js $NODE_MAJOR < 20 required"
  fi
fi

# Docker daemon running
if docker info &>/dev/null 2>&1; then
  pass "Docker daemon is running"
else
  fail "Docker daemon is not running — start Docker Desktop or dockerd"
fi

# ── Section 2: Repository Structure ──────────────────────────────────────────
header "2 · Repository Structure"

REQUIRED_FILES=(
  "backend/src/app.js"
  "backend/src/db/index.js"
  "backend/src/db/schema.sql"
  "backend/src/db/migrate.js"
  "backend/src/middleware/auth.js"
  "backend/src/middleware/audit.js"
  "backend/src/middleware/agent-auth.js"
  "backend/src/middleware/plan-limits.js"
  "backend/src/ai-manager.js"
  "backend/src/openclaw-client.js"
  "backend/src/queues/index.js"
  "backend/src/workers/worker-registry.js"
  "backend/src/routes/health.js"
  "backend/src/routes/auth.js"
  "backend/src/routes/workflows.js"
  "backend/src/routes/tasks.js"
  "backend/src/routes/billing.js"
  "backend/src/routes/approvals.js"
  "backend/src/routes/audit.js"
  "backend/src/routes/invoices.js"
  "backend/src/routes/stripe-webhook.js"
  "backend/src/routes/compliance.js"
  "backend/src/routes/gateways.js"
  "backend/src/config/plans.js"
  "backend/src/config/stripe.js"
  "backend/package.json"
  "backend/Dockerfile"
  "docker-compose.yml"
  "gateway/src"
  "gateway/Dockerfile"
  "playbooks/daily_health_check.json"
  "playbooks/backup_verify.json"
  "playbooks/invoice_to_archive.json"
  "scripts/bootstrap_deploy.sh"
  "scripts/smoke_test.sh"
  "terraform/main.tf"
  ".github/workflows/deploy.yml"
  ".github/workflows/ci.yml"
  ".env.example"
  "README.md"
)

for f in "${REQUIRED_FILES[@]}"; do
  if [[ -e "$f" ]]; then
    pass "$f"
  else
    fail "$f — MISSING"
  fi
done

# ── Section 3: .env Validation ────────────────────────────────────────────────
header "3 · Environment Variables"

ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  warn ".env not found — using .env.example as reference (safe for local dev)"
  ENV_FILE="$ENV_EXAMPLE"
fi

REQUIRED_VARS=(
  "DATABASE_URL"
  "REDIS_URL"
  "JWT_SECRET"
  "JWT_REFRESH_SECRET"
  "AGENT_INTERNAL_KEY"
  "GATEWAY_SECRET"
  "INTERNAL_HEALTH_KEY"
)

OPTIONAL_VARS=(
  "OPENAI_API_KEY"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
  "SMTP_HOST"
)

# Load the .env file without executing it
set +u
while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  export "CHECK_$key"="$val"
done < "$ENV_FILE"
set -u

for var in "${REQUIRED_VARS[@]}"; do
  key="CHECK_$var"
  if [[ -n "${!key:-}" ]]; then
    pass "$var is set"
  else
    fail "$var is NOT set in $ENV_FILE"
  fi
done

for var in "${OPTIONAL_VARS[@]}"; do
  key="CHECK_$var"
  if [[ -n "${!key:-}" ]]; then
    pass "$var is set (optional)"
  else
    warn "$var not set — some features disabled"
  fi
done

# JWT_SECRET entropy check
JWT_KEY="CHECK_JWT_SECRET"
if [[ -n "${!JWT_KEY:-}" ]]; then
  JWT_LEN=${#!JWT_KEY}
  if [[ "${!JWT_KEY}" != *"change_in_production"* && ${#!JWT_KEY} -ge 32 ]]; then
    pass "JWT_SECRET has sufficient entropy (${#!JWT_KEY} chars)"
  else
    warn "JWT_SECRET looks like a placeholder — replace before production"
  fi
fi

# ── Section 4: Node Dependencies ─────────────────────────────────────────────
header "4 · Node.js Dependencies"

if [[ -f "backend/package.json" ]]; then
  if [[ -d "backend/node_modules" ]]; then
    pass "backend/node_modules exists"
    # Check critical dependencies
    CRITICAL_DEPS=("express" "jsonwebtoken" "pg" "bullmq" "ioredis" "bcryptjs" "nodemailer" "stripe")
    for dep in "${CRITICAL_DEPS[@]}"; do
      if [[ -d "backend/node_modules/$dep" ]]; then
        ver=$(node -e "try{process.stdout.write(require('./backend/node_modules/$dep/package.json').version)}catch(e){process.stdout.write('?')}" 2>/dev/null || echo "?")
        pass "  $dep@$ver"
      else
        fail "  $dep missing — run: cd backend && npm install"
      fi
    done
  else
    warn "backend/node_modules not found — run: cd backend && npm install"
    info "Run: cd backend && npm ci --production=false"
  fi
fi

# ── Section 5: Docker Build (skip with --quick) ───────────────────────────────
if $QUICK; then
  header "5 · Docker Build  [SKIPPED — --quick mode]"
  warn "Docker build check skipped"
else
  header "5 · Docker Build"

  if docker info &>/dev/null 2>&1; then
    info "Building backend image (this may take ~60s on first run)…"
    if docker build \
        --target production \
        --tag realsync-backend:preflight \
        --file backend/Dockerfile \
        backend/ \
        > /tmp/realsync_docker_build.log 2>&1; then
      pass "backend Docker image built successfully"

      # Verify the image runs and responds
      info "Starting test container…"
      CID=$(docker run -d \
        --rm \
        -e NODE_ENV=test \
        -e PORT=8080 \
        -e DATABASE_URL="postgresql://x:x@localhost/x" \
        -e REDIS_URL="redis://localhost:6379" \
        -e JWT_SECRET="preflight_test_secret_32_chars_xx" \
        -e JWT_REFRESH_SECRET="preflight_refresh_secret_32chars" \
        -e AGENT_INTERNAL_KEY="preflight_agent_key_16chars" \
        -e GATEWAY_SECRET="preflight_gateway_secret" \
        -e INTERNAL_HEALTH_KEY="preflight_health_key" \
        -p 18080:8080 \
        realsync-backend:preflight 2>/dev/null)

      sleep 5
      if curl -sf http://localhost:18080/health/live > /dev/null 2>&1; then
        pass "Container liveness endpoint /health/live → 200"
      else
        warn "Container started but /health/live unreachable (DB/Redis not connected — expected)"
      fi
      docker stop "$CID" > /dev/null 2>&1 || true
    else
      fail "Docker build failed — see /tmp/realsync_docker_build.log"
      if ! $CI; then
        tail -30 /tmp/realsync_docker_build.log
      fi
    fi
  else
    warn "Docker daemon not running — build check skipped"
  fi
fi

# ── Section 6: Docker Compose Validation ─────────────────────────────────────
header "6 · Docker Compose"

if [[ -f "docker-compose.yml" ]]; then
  if docker compose config --quiet 2>/dev/null || docker-compose config --quiet 2>/dev/null; then
    pass "docker-compose.yml syntax is valid"
  else
    fail "docker-compose.yml has syntax errors"
  fi
else
  fail "docker-compose.yml not found"
fi

# ── Section 7: Schema & Migrations ───────────────────────────────────────────
header "7 · Database Schema & Migrations"

SCHEMA="backend/src/db/schema.sql"
if [[ -f "$SCHEMA" ]]; then
  # Count tables defined
  TABLE_COUNT=$(grep -c "^CREATE TABLE" "$SCHEMA" || true)
  pass "schema.sql found — $TABLE_COUNT tables defined"

  # Check required tables
  REQUIRED_TABLES=("tenants" "users" "workflow_runs" "tasks" "human_approvals" "audit_logs" "invoices" "health_metrics")
  for tbl in "${REQUIRED_TABLES[@]}"; do
    if grep -q "CREATE TABLE.*$tbl" "$SCHEMA" 2>/dev/null; then
      pass "  table: $tbl"
    else
      warn "  table: $tbl not found in schema.sql"
    fi
  done
fi

# Check migrations exist
MIGRATION_DIR="backend/src/db/migrations"
if [[ -d "$MIGRATION_DIR" ]]; then
  MIG_COUNT=$(find "$MIGRATION_DIR" -name "*.sql" | wc -l | tr -d ' ')
  pass "migrations/ found — $MIG_COUNT migration files"
else
  warn "migrations/ directory not found"
fi

# ── Section 8: Playbooks ──────────────────────────────────────────────────────
header "8 · MVP Playbooks"

PLAYBOOKS=(
  "playbooks/daily_health_check.json"
  "playbooks/backup_verify.json"
  "playbooks/invoice_to_archive.json"
)

for pb in "${PLAYBOOKS[@]}"; do
  if [[ -f "$pb" ]]; then
    if jq empty "$pb" 2>/dev/null; then
      NAME=$(jq -r '.name // "unnamed"' "$pb")
      STEPS=$(jq '.steps | length' "$pb" 2>/dev/null || echo "?")
      pass "$pb  →  name=$NAME  steps=$STEPS"
    else
      fail "$pb — invalid JSON"
    fi
  else
    fail "$pb — MISSING"
  fi
done

# ── Section 9: Security Checks ────────────────────────────────────────────────
header "9 · Security"

# .gitignore covers secrets
if [[ -f ".gitignore" ]]; then
  for secret_file in ".env" "generated_secrets.env" "*.pem" "*.key" "terraform.tfvars"; do
    if grep -q "$secret_file" .gitignore 2>/dev/null; then
      pass ".gitignore covers: $secret_file"
    else
      warn ".gitignore missing entry for: $secret_file"
    fi
  done
else
  fail ".gitignore not found"
fi

# No secrets accidentally committed
if git log --oneline 2>/dev/null | head -1 | grep -q "^"; then
  if git ls-files | grep -E "\.(env|pem|key)$" | grep -v "\.env\.example" | grep -q "."; then
    fail "Sensitive files tracked by git — check: git ls-files | grep -E '\.(env|pem|key)$'"
  else
    pass "No .env / .pem / .key files tracked by git"
  fi
fi

# Check for placeholder secrets in committed code
if grep -r "CHANGE_ME\|replace_me\|your_secret_here\|sk_live_" \
    backend/src/ gateway/src/ 2>/dev/null | \
    grep -v "node_modules\|\.example" | \
    grep -q "." 2>/dev/null; then
  warn "Placeholder secrets found in source — verify before production"
else
  pass "No placeholder secrets in source code"
fi

# ── Section 10: GitHub Actions ────────────────────────────────────────────────
header "10 · CI/CD Pipelines"

for workflow in ".github/workflows/deploy.yml" ".github/workflows/ci.yml"; do
  if [[ -f "$workflow" ]]; then
    # Basic YAML lint via Python (usually available)
    if command -v python3 &>/dev/null; then
      if python3 -c "import yaml; yaml.safe_load(open('$workflow'))" 2>/dev/null; then
        pass "$workflow — valid YAML"
      else
        fail "$workflow — YAML syntax error"
      fi
    else
      pass "$workflow — exists (YAML lint skipped, python3 not found)"
    fi
  else
    fail "$workflow — MISSING"
  fi
done

# ── Section 11: Terraform ─────────────────────────────────────────────────────
header "11 · Terraform"

if [[ -f "terraform/main.tf" ]]; then
  pass "terraform/main.tf exists"
  # Count resources
  TF_RESOURCES=$(grep -c "^resource " terraform/main.tf 2>/dev/null || echo "?")
  info "$TF_RESOURCES resource blocks in main.tf"
else
  fail "terraform/main.tf not found"
fi

if [[ -f "terraform/terraform.tfvars.example" ]]; then
  pass "terraform.tfvars.example exists"
  if [[ -f "terraform/terraform.tfvars" ]]; then
    warn "terraform/terraform.tfvars exists — ensure it is in .gitignore"
  fi
fi

if command -v terraform &>/dev/null; then
  TF_VER=$(terraform version -json 2>/dev/null | jq -r '.terraform_version' 2>/dev/null || terraform version | head -1)
  pass "terraform installed: $TF_VER"

  info "Running terraform validate…"
  if (cd terraform && terraform init -backend=false -input=false -no-color > /dev/null 2>&1 && \
      terraform validate -no-color 2>&1); then
    pass "terraform validate passed"
  else
    warn "terraform validate failed — run manually: cd terraform && terraform init && terraform validate"
  fi
else
  warn "terraform not installed locally — skipped (validated in CI)"
fi

# ── Section 12: API Contract Smoke (no server needed) ────────────────────────
header "12 · Static API Contract"

APP_JS="backend/src/app.js"
if [[ -f "$APP_JS" ]]; then
  REQUIRED_ROUTES=(
    "/health"
    "/api/v1/auth"
    "/api/v1/workflows"
    "/api/v1/tasks"
    "/api/v1/billing"
    "/api/v1/approvals"
    "/api/v1/audit"
    "/api/v1/invoices"
    "/api/v1/gateways"
    "/api/v1/compliance"
    "/webhooks/stripe"
  )
  for route in "${REQUIRED_ROUTES[@]}"; do
    if grep -q "$route" "$APP_JS" 2>/dev/null; then
      pass "route registered: $route"
    else
      fail "route missing in app.js: $route"
    fi
  done
fi

# ── Results ───────────────────────────────────────────────────────────────────
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo ""
echo "═══════════════════════════════════════════════════"
echo -e "${BOLD}Pre-Flight Results  (${ELAPSED}s)${NC}"
echo "═══════════════════════════════════════════════════"
echo -e "  ${GREEN}✔ Passed :${NC}  $PASS"
echo -e "  ${YELLOW}⚠ Warnings:${NC} $WARN"
echo -e "  ${RED}✘ Failed :${NC}  $FAIL"
echo "═══════════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "\n${RED}${BOLD}PRE-FLIGHT FAILED — fix $FAIL error(s) before deploying.${NC}\n"
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  echo -e "\n${YELLOW}${BOLD}PRE-FLIGHT PASSED WITH WARNINGS — review $WARN warning(s).${NC}\n"
  exit 0
else
  echo -e "\n${GREEN}${BOLD}PRE-FLIGHT PASSED — ready to deploy.${NC}\n"
  exit 0
fi
