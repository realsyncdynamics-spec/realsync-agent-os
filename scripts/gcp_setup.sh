#!/usr/bin/env bash
# ============================================================
# RealSync Agent-OS — GCP One-Time Setup Script
# Run once per project to provision Artifact Registry,
# Service Account, IAM roles, and Secret Manager secrets.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Owner/Editor permissions on the GCP project
#
# Usage:
#   export GCP_PROJECT_ID=your-project-id
#   bash scripts/gcp_setup.sh
# ============================================================

set -euo pipefail

# ── Config ───────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"
REGION="europe-west1"
REGISTRY_NAME="realsync-agent-os"
SA_NAME="realsync-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=========================================="
echo "RealSync Agent-OS — GCP Setup"
echo "Project : ${PROJECT_ID}"
echo "Region  : ${REGION}"
echo "=========================================="

# ── 1. Enable required APIs ──────────────────────────────────
echo ""
echo "[1/6] Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  --project="${PROJECT_ID}"
echo "  APIs enabled."

# ── 2. Create Artifact Registry repository ───────────────────
echo ""
echo "[2/6] Creating Artifact Registry repository..."
if gcloud artifacts repositories describe "${REGISTRY_NAME}" \
     --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  echo "  Repository '${REGISTRY_NAME}' already exists — skipping."
else
  gcloud artifacts repositories create "${REGISTRY_NAME}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="RealSync Agent-OS container images" \
    --project="${PROJECT_ID}"
  echo "  Repository created."
fi

# ── 3. Create Deployer Service Account ───────────────────────
echo ""
echo "[3/6] Creating Service Account '${SA_NAME}'..."
if gcloud iam service-accounts describe "${SA_EMAIL}" \
     --project="${PROJECT_ID}" &>/dev/null; then
  echo "  Service account already exists — skipping."
else
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="RealSync CI/CD Deployer" \
    --project="${PROJECT_ID}"
  echo "  Service account created: ${SA_EMAIL}"
fi

# ── 4. Assign IAM roles ──────────────────────────────────────
echo ""
echo "[4/6] Assigning IAM roles..."
ROLES=(
  "roles/run.admin"
  "roles/artifactregistry.writer"
  "roles/secretmanager.secretAccessor"
  "roles/iam.serviceAccountUser"
)
for ROLE in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet
  echo "  Granted: ${ROLE}"
done

# ── 5. Create JSON key for GitHub Actions ────────────────────
echo ""
echo "[5/6] Creating Service Account key (GCP_SA_KEY)..."
KEY_FILE="/tmp/realsync-sa-key.json"
gcloud iam service-accounts keys create "${KEY_FILE}" \
  --iam-account="${SA_EMAIL}" \
  --project="${PROJECT_ID}"
echo ""
echo "  ⚠️  Add the following as a GitHub Actions secret named GCP_SA_KEY:"
echo "  ──────────────────────────────────────────────────────"
cat "${KEY_FILE}"
echo ""
echo "  ──────────────────────────────────────────────────────"
echo "  Key file also saved to: ${KEY_FILE}"
echo "  Delete it after adding to GitHub: rm ${KEY_FILE}"

# ── 6. Create placeholder secrets in Secret Manager ─────────
echo ""
echo "[6/6] Creating Secret Manager placeholders..."
SECRETS=(
  "DATABASE_URL"
  "REDIS_URL"
  "JWT_SECRET"
  "JWT_REFRESH_SECRET"
  "OPENAI_API_KEY"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
  "OPENCLAW_API_KEY"
  "GATEWAY_SECRET"
)
for SECRET in "${SECRETS[@]}"; do
  if gcloud secrets describe "${SECRET}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  Secret '${SECRET}' already exists — skipping."
  else
    echo -n "PLACEHOLDER_REPLACE_ME" | \
      gcloud secrets create "${SECRET}" \
        --data-file=- \
        --replication-policy=user-managed \
        --locations="${REGION}" \
        --project="${PROJECT_ID}"
    echo "  Created: ${SECRET}"
  fi
done

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "=========================================="
echo "Setup complete. Required GitHub Secrets:"
echo "  GCP_PROJECT_ID  = ${PROJECT_ID}"
echo "  GCP_SA_KEY      = (see JSON output above)"
echo "  GCP_DEPLOY_SA   = ${SA_EMAIL}"
echo ""
echo "Registry URL:"
echo "  ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REGISTRY_NAME}/"
echo ""
echo "Next steps:"
echo "  1. Add GCP_PROJECT_ID, GCP_SA_KEY, GCP_DEPLOY_SA to GitHub repo secrets"
echo "  2. Replace all PLACEHOLDER_REPLACE_ME values in Secret Manager"
echo "  3. Push to main to trigger first deploy"
echo "=========================================="
