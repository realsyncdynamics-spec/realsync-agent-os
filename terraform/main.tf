###############################################################################
# RealSyncDynamics Agent-OS — GCP Bootstrap
# Terraform equivalent of scripts/gcp_setup.sh
###############################################################################

terraform {
  required_version = ">= 1.7.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

###############################################################################
# Provider
###############################################################################

provider "google" {
  project = var.project_id
  region  = var.region
}

###############################################################################
# Enable APIs
###############################################################################

locals {
  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
  ]

  secret_names = [
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET",
    "OPENAI_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "OPENCLAW_API_KEY",
    "AGENT_INTERNAL_KEY",
    "GATEWAY_SECRET",
    "INTERNAL_HEALTH_KEY",
  ]

  deployer_roles = [
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/secretmanager.secretAccessor",
    "roles/iam.serviceAccountUser",
    "roles/iam.serviceAccountTokenCreator",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

###############################################################################
# Artifact Registry
###############################################################################

resource "google_artifact_registry_repository" "realsync" {
  project       = var.project_id
  location      = "europe-west1"
  repository_id = "realsync-agent-os"
  format        = "DOCKER"
  description   = "RealSyncDynamics Agent-OS container images"

  depends_on = [google_project_service.apis["artifactregistry.googleapis.com"]]
}

###############################################################################
# Service Account — Deployer
###############################################################################

resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "realsync-deployer"
  display_name = "RealSync Deployer"
  description  = "Service account used by CI/CD to deploy Agent-OS workloads"

  depends_on = [google_project_service.apis["iam.googleapis.com"]]
}

###############################################################################
# IAM bindings for deployer SA
###############################################################################

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset(local.deployer_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

###############################################################################
# Secret Manager — secrets
###############################################################################

resource "google_secret_manager_secret" "secrets" {
  for_each = toset(local.secret_names)

  project   = var.project_id
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = "europe-west1"
      }
    }
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "placeholders" {
  for_each = toset(local.secret_names)

  secret      = google_secret_manager_secret.secrets[each.value].id
  secret_data = "PLACEHOLDER_REPLACE_ME"

  lifecycle {
    # Prevent Terraform from overwriting real secret values on subsequent applies
    ignore_changes = [secret_data]
  }
}
