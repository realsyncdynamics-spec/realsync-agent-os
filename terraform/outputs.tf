###############################################################################
# Outputs — RealSyncDynamics Agent-OS GCP Bootstrap
###############################################################################

output "deployer_sa_email" {
  description = "Email address of the realsync-deployer service account."
  value       = google_service_account.deployer.email
}

output "artifact_registry_url" {
  description = "Docker registry URL for pushing and pulling Agent-OS images."
  value       = "europe-west1-docker.pkg.dev/${var.project_id}/realsync-agent-os"
}

output "secret_manager_secrets" {
  description = "List of Secret Manager secret IDs provisioned for Agent-OS."
  value       = [for s in google_secret_manager_secret.secrets : s.secret_id]
}
