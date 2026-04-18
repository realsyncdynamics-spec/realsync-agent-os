#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — ONE-SHOT BOOTSTRAP & DEPLOY
#
# Dieses Script übernimmt den gesamten Deploy-Prozess:
#   1. GCP APIs aktivieren
#   2. Artifact Registry anlegen
#   3. Deployer Service Account + IAM
#   4. Secret Manager befüllen (alle 11 Secrets)
#   5. GitHub Secrets setzen (via gh CLI)
#   6. GitHub Environment 'production' anlegen
#   7. Ersten Deploy triggern
#
# VORAUSSETZUNGEN (die einzigen manuellen Schritte):
#   gcloud auth login
#   gh auth login
#   export GCP_PROJECT_ID=dein-projekt-id
#   export OPENAI_API_KEY=sk-...
#   export STRIPE_SECRET_KEY=sk_live_...   (oder sk_test_... zum Testen)
#   export STRIPE_WEBHOOK_SECRET=whsec_...
#   export DATABASE_URL=postgresql://...
#   export REDIS_URL=redis://...
#
# Dann: bash scripts/bootstrap_deploy.sh
# ============================================================
set -euo pipefail

# ── Farben ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${GREEN}[✓]${RESET} $*"; }
info() { echo -e "${BLUE}[→]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
fail() { echo -e "${RED}[✗]${RESET} $*"; exit 1; }
step() { echo -e "\n${BOLD}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

# ── Konfiguration ────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?Setze: export GCP_PROJECT_ID=dein-projekt-id}"
REGION="europe-west1"
REGISTRY="realsync-agent-os"
SA_NAME="realsync-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
GITHUB_REPO="realsyncdynamics-spec/realsync-agent-os"
KEY_FILE="/tmp/realsync-sa-key-$(date +%Y%m%d%H%M%S).json"

# ── Pflicht-Secrets prüfen ───────────────────────────────────
MISSING=0
for VAR in OPENAI_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET DATABASE_URL REDIS_URL; do
  if [[ -z "${!VAR:-}" ]]; then
    warn "Nicht gesetzt: export ${VAR}=..."
    MISSING=1
  fi
done
[[ $MISSING -eq 1 ]] && fail "Setze alle Pflicht-Variablen (siehe oben) und starte erneut."

# ── Lokal generierte Secrets einlesen ────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="${SCRIPT_DIR}/../generated_secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  source "$SECRETS_FILE"
  log "Kryptografische Secrets aus generated_secrets.env geladen."
else
  warn "generated_secrets.env nicht gefunden — generiere neu..."
  JWT_SECRET=$(openssl rand -hex 64)
  JWT_REFRESH_SECRET=$(openssl rand -hex 64)
  AGENT_INTERNAL_KEY=$(openssl rand -hex 32)
  GATEWAY_SECRET=$(openssl rand -hex 32)
  INTERNAL_HEALTH_KEY=$(openssl rand -hex 32)
  log "Neue Secrets generiert."
fi

echo ""
echo -e "${BOLD}RealSync Agent-OS — One-Shot Bootstrap${RESET}"
echo -e "Projekt : ${BLUE}${PROJECT_ID}${RESET}"
echo -e "Region  : ${BLUE}${REGION}${RESET}"
echo -e "Repo    : ${BLUE}${GITHUB_REPO}${RESET}"
echo ""
read -rp "Fortfahren? [j/N] " CONFIRM
[[ "${CONFIRM,,}" != "j" ]] && fail "Abgebrochen."

# ────────────────────────────────────────────────────────────
step "1/7 GCP APIs aktivieren"
# ────────────────────────────────────────────────────────────
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"
log "APIs aktiviert."

# ────────────────────────────────────────────────────────────
step "2/7 Artifact Registry anlegen"
# ────────────────────────────────────────────────────────────
if gcloud artifacts repositories describe "${REGISTRY}" \
   --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  info "Repository '${REGISTRY}' existiert bereits — übersprungen."
else
  gcloud artifacts repositories create "${REGISTRY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="RealSync Agent-OS container images" \
    --project="${PROJECT_ID}"
  log "Artifact Registry angelegt: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY}/"
fi

# ────────────────────────────────────────────────────────────
step "3/7 Service Account + IAM"
# ────────────────────────────────────────────────────────────
if ! gcloud iam service-accounts describe "${SA_EMAIL}" \
   --project="${PROJECT_ID}" &>/dev/null; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="RealSync CI/CD Deployer" \
    --project="${PROJECT_ID}"
  log "Service Account erstellt: ${SA_EMAIL}"
else
  info "Service Account existiert bereits."
fi

for ROLE in roles/run.admin roles/artifactregistry.writer \
            roles/secretmanager.secretAccessor \
            roles/iam.serviceAccountUser roles/iam.serviceAccountTokenCreator; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" --condition=None --quiet
  log "IAM: ${ROLE}"
done

# SA Key für GitHub Actions
gcloud iam service-accounts keys create "${KEY_FILE}" \
  --iam-account="${SA_EMAIL}" --project="${PROJECT_ID}"
log "SA-Key erstellt: ${KEY_FILE}"

# ────────────────────────────────────────────────────────────
step "4/7 Secret Manager befüllen"
# ────────────────────────────────────────────────────────────
put_secret() {
  local NAME="$1" VALUE="$2"
  if gcloud secrets describe "${NAME}" --project="${PROJECT_ID}" &>/dev/null; then
    echo -n "${VALUE}" | gcloud secrets versions add "${NAME}" \
      --data-file=- --project="${PROJECT_ID}"
    log "Secret aktualisiert: ${NAME}"
  else
    echo -n "${VALUE}" | gcloud secrets create "${NAME}" \
      --data-file=- \
      --replication-policy=user-managed \
      --locations="${REGION}" \
      --project="${PROJECT_ID}"
    log "Secret erstellt: ${NAME}"
  fi
}

put_secret "DATABASE_URL"            "${DATABASE_URL}"
put_secret "REDIS_URL"               "${REDIS_URL}"
put_secret "JWT_SECRET"              "${JWT_SECRET}"
put_secret "JWT_REFRESH_SECRET"      "${JWT_REFRESH_SECRET}"
put_secret "OPENAI_API_KEY"          "${OPENAI_API_KEY}"
put_secret "STRIPE_SECRET_KEY"       "${STRIPE_SECRET_KEY}"
put_secret "STRIPE_WEBHOOK_SECRET"   "${STRIPE_WEBHOOK_SECRET}"
put_secret "OPENCLAW_API_KEY"        "${OPENCLAW_API_KEY:-PLACEHOLDER_SET_LATER}"
put_secret "AGENT_INTERNAL_KEY"      "${AGENT_INTERNAL_KEY}"
put_secret "GATEWAY_SECRET"          "${GATEWAY_SECRET}"
put_secret "INTERNAL_HEALTH_KEY"     "${INTERNAL_HEALTH_KEY}"

# ────────────────────────────────────────────────────────────
step "5/7 GitHub Secrets setzen"
# ────────────────────────────────────────────────────────────
gh secret set GCP_PROJECT_ID  --repo="${GITHUB_REPO}" --body="${PROJECT_ID}"
log "GitHub Secret: GCP_PROJECT_ID"

gh secret set GCP_SA_KEY      --repo="${GITHUB_REPO}" < "${KEY_FILE}"
log "GitHub Secret: GCP_SA_KEY"

gh secret set GCP_DEPLOY_SA   --repo="${GITHUB_REPO}" --body="${SA_EMAIL}"
log "GitHub Secret: GCP_DEPLOY_SA"

# ────────────────────────────────────────────────────────────
step "6/7 GitHub Environment 'production' anlegen"
# ────────────────────────────────────────────────────────────
# gh CLI kann Environments nur über API anlegen
GH_USER=$(gh api user --jq '.login')
PROJECT_NUM=$(gh api "repos/${GITHUB_REPO}" --jq '.id')

gh api --method PUT \
  "repos/${GITHUB_REPO}/environments/production" \
  --field "wait_timer=0" \
  --field "prevent_self_review=false" \
  > /dev/null && log "GitHub Environment 'production' angelegt." \
  || warn "Environment konnte nicht per API angelegt werden — bitte manuell in GitHub Settings anlegen."

# ────────────────────────────────────────────────────────────
step "7/7 Ersten Deploy triggern"
# ────────────────────────────────────────────────────────────
# Leeren Commit pushen um die Pipeline zu starten
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

git config user.email "256874684+realsyncdynamics-spec@users.noreply.github.com" 2>/dev/null || true
git config user.name "realsyncdynamics-spec" 2>/dev/null || true
git commit --allow-empty -m "chore: trigger first Cloud Run deploy [bootstrap_deploy.sh]"
git push origin main
log "Deploy-Trigger gepusht."

# ── Aufräumen ────────────────────────────────────────────────
rm -f "${KEY_FILE}"
log "SA-Key lokal gelöscht."

# ── Zusammenfassung ──────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  Bootstrap abgeschlossen!${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Registry : ${BLUE}${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY}/${RESET}"
echo -e "  SA       : ${BLUE}${SA_EMAIL}${RESET}"
echo -e "  Pipeline : ${BLUE}https://github.com/${GITHUB_REPO}/actions${RESET}"
echo ""
echo -e "${YELLOW}Nächster Schritt:${RESET}"
echo -e "  1. GitHub Actions öffnen"
echo -e "  2. Laufenden Workflow anklicken"
echo -e "  3. ${BOLD}Review deployments → production → Approve${RESET}"
echo -e "  4. Warten bis ${GREEN}✓ Deploy Complete${RESET}"
echo ""
echo -e "Danach Smoke-Test:"
echo -e "  bash scripts/smoke_test.sh \$(gcloud run services describe realsync-backend \\"
echo -e "    --region ${REGION} --format 'value(status.url)')"
echo ""
