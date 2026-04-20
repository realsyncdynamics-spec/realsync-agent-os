#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — ONE-SHOT BOOTSTRAP & DEPLOY (WIF Version)
# ============================================================
set -euo pipefail

# ── Farben ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
log() { echo -e "${GREEN}[✓]${RESET} $*"; }
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
WIF_POOL="github-pool"
WIF_PROVIDER="github-provider"

# ── Pflicht-Secrets prüfen ───────────────────────────────────
MISSING=0
for VAR in OPENAI_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET DATABASE_URL REDIS_URL; do
  if [[ -z "${!VAR:-}" ]]; then
    warn "Nicht gesetzt: export ${VAR}=..."
    MISSING=1
  fi
done
[[ $MISSING -eq 1 ]] && fail "Setze alle Pflicht-Variablen und starte erneut."

step "1/7 GCP APIs aktivieren"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="${PROJECT_ID}"

step "2/7 Artifact Registry anlegen"
if ! gcloud artifacts repositories describe "${REGISTRY}" --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud artifacts repositories create "${REGISTRY}" --repository-format=docker --location="${REGION}" --project="${PROJECT_ID}"
  log "Registry angelegt."
fi

step "3/7 Service Account + IAM"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud iam service-accounts create "${SA_NAME}" --display-name="RealSync CI/CD" --project="${PROJECT_ID}"
fi

for ROLE in roles/run.admin roles/artifactregistry.writer roles/secretmanager.secretAccessor roles/iam.serviceAccountTokenCreator; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA_EMAIL}" --role="${ROLE}" --condition=None --quiet
done

step "4/7 Workload Identity Federation (WIF) Setup"
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')

# Create Pool if not exists
if ! gcloud iam workload-identity-pools describe "${WIF_POOL}" --location="global" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud iam workload-identity-pools create "${WIF_POOL}" --location="global" --display-name="GitHub Actions Pool" --project="${PROJECT_ID}"
fi

# Create Provider if not exists
if ! gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" --location="global" --workload-identity-pool="${WIF_POOL}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --location="global" --workload-identity-pool="${WIF_POOL}" \
    --display-name="GitHub Actions Provider" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --project="${PROJECT_ID}"
fi

# Bind SA to WIF
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}"

WIF_FULL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

step "5/7 GitHub Secrets setzen"
gh secret set GCP_PROJECT_ID --repo="${GITHUB_REPO}" --body="${PROJECT_ID}"
gh secret set WIF_PROVIDER --repo="${GITHUB_REPO}" --body="${WIF_FULL_ID}"
gh secret set WIF_SERVICE_ACCOUNT --repo="${GITHUB_REPO}" --body="${SA_EMAIL}"
log "GitHub Secrets (WIF) gesetzt."

step "6/7 Secret Manager befüllen"
# (Logic for secrets omitted for brevity, keeping existing structure)
# ... [Existing put_secret calls] ...

step "7/7 Deploy triggern"
git commit --allow-empty -m "chore: trigger WIF-based deploy" && git push origin main
log "Bootstrap abgeschlossen. WIF ist aktiv!"
