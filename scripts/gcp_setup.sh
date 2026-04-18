#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — GCP One-Time Setup Script v2
# Sprint 4: Added Workload Identity Federation option,
#           Cloud Run IAM invoker, pg_cron hint,
#           and GitHub Environments documentation.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Owner/Editor permissions on the GCP project
#
# Usage:
#   export GCP_PROJECT_ID=your-project-id
#   bash scripts/gcp_setup.sh
#
# Optional — use Workload Identity instead of JSON key:
#   export USE_WORKLOAD_IDENTITY=true
#   export GITHUB_REPO=realsyncdynamics-spec/realsync-agent-os
# ============================================================

set -euo pipefail

# ── Config ───────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"
REGION="europe-west1"
REGISTRY_NAME="realsync-agent-os"
SA_NAME="realsync-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
USE_WIF="${USE_WORKLOAD_IDENTITY:-false}"
GITHUB_REPO="${GITHUB_REPO:-realsyncdynamics-spec/realsync-agent-os}"

echo "=========================================="
echo "RealSync Agent-OS — GCP Setup v2"
echo "Project : ${PROJECT_ID}"
echo "Region  : ${REGION}"
echo "Auth    : $([ "$USE_WIF" = "true" ] && echo "Workload Identity Federation" || echo "Service Account JSON Key")"
echo "=========================================="

# ── 1. Enable required APIs ──────────────────────────────────
echo ""
echo "[1/7] Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}"
echo "  ✓ APIs enabled."

# ── 2. Artifact Registry ─────────────────────────────────────
echo ""
echo "[2/7] Artifact Registry..."
if gcloud artifacts repositories describe "${REGISTRY_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  echo "  Skipping — '${REGISTRY_NAME}' already exists."
else
  gcloud artifacts repositories create "${REGISTRY_NAME}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="RealSync Agent-OS container images — EU AI Act compliant" \
    --project="${PROJECT_ID}"
  echo "  ✓ Repository created."
fi

# ── 3. Deployer Service Account ──────────────────────────────
echo ""
echo "[3/7] Service Account '${SA_NAME}'..."
if gcloud iam service-accounts describe "${SA_EMAIL}" \
     --project="${PROJECT_ID}" &>/dev/null; then
  echo "  Skipping — service account already exists."
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="RealSync CI/CD Deployer (GitHub Actions)" \
    --description="Used by GitHub Actions to deploy to Cloud Run" \
    --project="${PROJECT_ID}"
  echo "  ✓ Created: ${SA_EMAIL}"
fi

# ── 4. IAM Roles ─────────────────────────────────────────────
echo ""
echo "[4/7] IAM roles..."
ROLES=(
  "roles/run.admin"
  "roles/artifactregistry.writer"
  "roles/secretmanager.secretAccessor"
  "roles/iam.serviceAccountUser"
  "roles/iam.serviceAccountTokenCreator"
)
for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
  echo "  ✓ ${ROLE}"
done

# Cloud Run service agent needs to invoke the service
CR_AGENT="service-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@serverless-robot-prod.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CR_AGENT}" \
  --role="roles/run.invoker" \
  --condition=None \
  --quiet || echo "  (Cloud Run agent binding skipped — may not exist yet)"

# ── 5. Auth Setup (JSON Key OR Workload Identity) ─────────────
echo ""
if [ "${USE_WIF}" = "true" ]; then
  echo "[5/7] Setting up Workload Identity Federation..."
  POOL_NAME="github-actions-pool"
  PROVIDER_NAME="github-provider"

  # Create pool
  if ! gcloud iam workload-identity-pools describe "${POOL_NAME}" \
       --location=global --project="${PROJECT_ID}" &>/dev/null; then
    gcloud iam workload-identity-pools create "${POOL_NAME}" \
      --location=global \
      --display-name="GitHub Actions Pool" \
      --project="${PROJECT_ID}"
    echo "  ✓ Identity pool created."
  fi

  # Create OIDC provider
  if ! gcloud iam workload-identity-pools providers describe "${PROVIDER_NAME}" \
       --location=global \
       --workload-identity-pool="${POOL_NAME}" \
       --project="${PROJECT_ID}" &>/dev/null; then
    gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_NAME}" \
      --location=global \
      --workload-identity-pool="${POOL_NAME}" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
      --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
      --project="${PROJECT_ID}"
    echo "  ✓ OIDC provider created."
  fi

  # Bind SA to pool
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
  POOL_FULL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/providers/${PROVIDER_NAME}"

  gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/attribute.repository/${GITHUB_REPO}" \
    --project="${PROJECT_ID}"

  echo ""
  echo "  ⚠️  Add these GitHub Secrets for Workload Identity:"
  echo "  WIF_PROVIDER      = ${POOL_FULL}"
  echo "  WIF_SERVICE_ACCOUNT = ${SA_EMAIL}"
  echo ""
  echo "  Then in deploy.yml, replace credentials_json with:"
  echo "    workload_identity_provider: \${{ secrets.WIF_PROVIDER }}"
  echo "    service_account: \${{ secrets.WIF_SERVICE_ACCOUNT }}"

else
  echo "[5/7] Creating Service Account JSON key..."
  KEY_FILE="/tmp/realsync-sa-key-$(date +%Y%m%d).json"
  gcloud iam service-accounts keys create "${KEY_FILE}" \
    --iam-account="${SA_EMAIL}" \
    --project="${PROJECT_ID}"
  echo ""
  echo "  ⚠️  Add as GitHub Secret GCP_SA_KEY:"
  echo "  ──────────────────────────────────"
  cat "${KEY_FILE}"
  echo ""
  echo "  ──────────────────────────────────"
  echo "  Key saved to: ${KEY_FILE}"
  echo "  Delete after adding to GitHub: rm ${KEY_FILE}"
fi

# ── 6. Secret Manager Placeholders ──────────────────────────
echo ""
echo "[6/7] Secret Manager placeholders..."
SECRETS=(
  "DATABASE_URL"
  "REDIS_URL"
  "JWT_SECRET"
  "JWT_REFRESH_SECRET"
  "OPENAI_API_KEY"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
  "OPENCLAW_API_KEY"
  "AGENT_INTERNAL_KEY"
  "GATEWAY_SECRET"
  "INTERNAL_HEALTH_KEY"
)
for SECRET in "${SECRETS[@]}"; do
  if gcloud secrets describe "${SECRET}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  Skipping '${SECRET}' — already exists."
  else
    echo -n "PLACEHOLDER_REPLACE_ME" | \
      gcloud secrets create "${SECRET}" \
        --data-file=- \
        --replication-policy=user-managed \
        --locations="${REGION}" \
        --project="${PROJECT_ID}"
    echo "  ✓ Created: ${SECRET}"
  fi
done

# ── 7. GitHub Environments Setup Reminder ────────────────────
echo ""
echo "[7/7] GitHub Environments (manual step required)..."
echo "  In your GitHub repo → Settings → Environments → 'production':"
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  ✅ Required reviewers: add yourself or your team        │"
echo "  │  ✅ Deployment branches: main only                       │"
echo "  │  ✅ Wait timer: 0 minutes (or 5 for change window)       │"
echo "  └─────────────────────────────────────────────────────────┘"
echo "  This gates every deploy behind a manual approval — satisfies"
echo "  EU AI Act Art. 14 human oversight for production deployments."

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "✅ Setup complete!"
echo ""
echo "GitHub Secrets required:"
echo "  GCP_PROJECT_ID  = ${PROJECT_ID}"
echo "  GCP_SA_KEY      = (see JSON output above)"
echo "  GCP_DEPLOY_SA   = ${SA_EMAIL}"
echo ""
echo "Registry:"
echo "  ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}/"
echo ""
echo "Next steps:"
echo "  1. Add GCP_PROJECT_ID, GCP_SA_KEY, GCP_DEPLOY_SA to GitHub Secrets"
echo "  2. Set up GitHub Environment 'production' with required reviewers"
echo "  3. Replace all PLACEHOLDER_REPLACE_ME secrets in Secret Manager"
echo "  4. git push origin main → approve the deploy → watch Cloud Run go live"
echo "=========================================="
