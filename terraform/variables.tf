###############################################################################
# Variables — RealSyncDynamics Agent-OS GCP Bootstrap
###############################################################################

variable "project_id" {
  description = "GCP project ID to deploy all resources into."
  type        = string
  # No default — must be supplied explicitly to avoid accidental cross-project deploys.
}

variable "region" {
  description = "Primary GCP region for all regional resources."
  type        = string
  default     = "europe-west1"
}

variable "github_repo" {
  description = <<-EOT
    GitHub repository in the form "owner/repo" used as the subject claim
    filter for Workload Identity Federation (WIF). Only relevant when
    var.use_workload_identity = true.
  EOT
  type        = string
  default     = "realsyncdynamics-spec/realsync-agent-os"
}

variable "use_workload_identity" {
  description = <<-EOT
    When true, creates a Workload Identity Pool + Provider so GitHub Actions
    can authenticate to GCP without long-lived service account keys.
    Set to false (default) to skip WIF resources and use a key-based SA instead.
  EOT
  type        = bool
  default     = false
}
