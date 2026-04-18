###############################################################################
# Workload Identity Federation — GitHub Actions → GCP
# All resources are conditional on var.use_workload_identity = true.
###############################################################################

# ---------------------------------------------------------------------------
# Workload Identity Pool
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  count = var.use_workload_identity ? 1 : 0

  project                   = var.project_id
  workload_identity_pool_id = "github-actions-pool"
  display_name              = "GitHub Actions Pool"
  description               = "Pool for GitHub Actions OIDC tokens (Agent-OS CI/CD)"
  disabled                  = false

  depends_on = [google_project_service.apis["iamcredentials.googleapis.com"]]
}

# ---------------------------------------------------------------------------
# Workload Identity Pool Provider (OIDC — token.actions.githubusercontent.com)
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool_provider" "github" {
  count = var.use_workload_identity ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC Provider"
  description                        = "Allows GitHub Actions jobs from ${var.github_repo} to impersonate the deployer SA"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }

  # Only tokens whose repository matches var.github_repo are accepted.
  attribute_condition = "attribute.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ---------------------------------------------------------------------------
# Allow the WIF pool to impersonate the deployer service account
# ---------------------------------------------------------------------------

resource "google_service_account_iam_member" "wif_binding" {
  count = var.use_workload_identity ? 1 : 0

  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repo}"
}

# ---------------------------------------------------------------------------
# Convenience output (only populated when WIF is enabled)
# ---------------------------------------------------------------------------

output "workload_identity_provider" {
  description = "Full WIF provider resource name for use in GitHub Actions workflows. Empty when use_workload_identity = false."
  value       = var.use_workload_identity ? google_iam_workload_identity_pool_provider.github[0].name : ""
}
