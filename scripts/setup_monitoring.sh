#!/usr/bin/env bash
# =============================================================================
# RealSync Agent-OS — Cloud Monitoring Alert Setup
#
# Erstellt Alert-Policies für:
#   1. Cloud Run Backend — hohe Fehlerrate (5xx > 1% über 5 min)
#   2. Cloud Run Backend — hohe Latenz (p99 > 3s über 5 min)
#   3. Cloud Run Backend — nicht erreichbar (0 requests über 10 min)
#   4. Cloud Run Gateway — 5xx Fehlerrate
#   5. DB-Migrationen fehlgeschlagen
#   6. BullMQ Dead-Letter Queue > 0 (via custom log metric)
#
# Voraussetzung:
#   gcloud auth login
#   export GCP_PROJECT_ID=realsync-prod-001
#   export ALERT_EMAIL=ops@realsyncdynamics.com
#
# Usage:
#   bash scripts/setup_monitoring.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
info() { echo -e "${BLUE}[→]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step() { echo -e "\n${BOLD}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

PROJECT="${GCP_PROJECT_ID:?export GCP_PROJECT_ID=...}"
REGION="europe-west1"
ALERT_EMAIL="${ALERT_EMAIL:-ops@realsyncdynamics.com}"
BACKEND_SVC="realsync-backend"
GATEWAY_SVC="realsync-gateway"

echo -e "\n${BOLD}RealSync Agent-OS — Monitoring Setup${NC}"
echo -e "Projekt  : ${BLUE}${PROJECT}${NC}"
echo -e "Region   : ${BLUE}${REGION}${NC}"
echo -e "E-Mail   : ${BLUE}${ALERT_EMAIL}${NC}"
echo ""

# ─── Notification Channel (E-Mail) anlegen ────────────────────────────────────
step "1/7 Notification Channel anlegen"

CHANNEL_JSON=$(cat <<EOF
{
  "type": "email",
  "displayName": "RealSync Ops E-Mail",
  "labels": {
    "email_address": "${ALERT_EMAIL}"
  },
  "enabled": true
}
EOF
)

# Prüfen ob Channel bereits existiert
EXISTING_CHANNEL=$(gcloud alpha monitoring channels list \
  --project="${PROJECT}" \
  --filter="type=email AND labels.email_address=${ALERT_EMAIL}" \
  --format="value(name)" 2>/dev/null | head -1 || echo "")

if [[ -n "${EXISTING_CHANNEL}" ]]; then
  CHANNEL_ID="${EXISTING_CHANNEL}"
  info "Notification Channel existiert bereits: ${CHANNEL_ID}"
else
  CHANNEL_ID=$(echo "${CHANNEL_JSON}" | \
    gcloud alpha monitoring channels create \
      --project="${PROJECT}" \
      --channel-content-from-file=/dev/stdin \
      --format="value(name)" 2>/dev/null)
  log "Notification Channel erstellt: ${CHANNEL_ID}"
fi

# ─── Helper: Alert Policy anlegen ─────────────────────────────────────────────

create_alert() {
  local NAME="$1"
  local DISPLAY_NAME="$2"
  local POLICY_JSON="$3"

  # Prüfen ob Policy bereits existiert
  EXISTING=$(gcloud alpha monitoring policies list \
    --project="${PROJECT}" \
    --filter="displayName='${DISPLAY_NAME}'" \
    --format="value(name)" 2>/dev/null | head -1 || echo "")

  if [[ -n "${EXISTING}" ]]; then
    info "Alert Policy existiert bereits: ${DISPLAY_NAME}"
    return 0
  fi

  echo "${POLICY_JSON}" | \
    gcloud alpha monitoring policies create \
      --project="${PROJECT}" \
      --policy-from-file=/dev/stdin \
      --format="value(name)" > /dev/null

  log "Alert Policy erstellt: ${DISPLAY_NAME}"
}

# ─── Alert 2: Backend 5xx Fehlerrate > 1% ─────────────────────────────────────
step "2/7 Alert: Backend 5xx Fehlerrate"

create_alert "backend-5xx-rate" "RealSync Backend — 5xx Fehlerrate > 1%" "$(cat <<EOF
{
  "displayName": "RealSync Backend — 5xx Fehlerrate > 1%",
  "documentation": {
    "content": "Cloud Run realsync-backend gibt mehr als 1% HTTP 5xx Fehler zurück. Logs: gcloud run services logs read ${BACKEND_SVC} --region ${REGION} --project ${PROJECT}",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "5xx Error Rate",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND_SVC}\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.01,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "ERROR"
}
EOF
)"

# ─── Alert 3: Backend p99 Latenz > 3s ─────────────────────────────────────────
step "3/7 Alert: Backend Latenz p99"

create_alert "backend-latency-p99" "RealSync Backend — p99 Latenz > 3s" "$(cat <<EOF
{
  "displayName": "RealSync Backend — p99 Latenz > 3s",
  "documentation": {
    "content": "Cloud Run realsync-backend p99-Latenz überschreitet 3 Sekunden. Mögliche Ursachen: DB-Überlastung, AI-Timeout, BullMQ-Rückstau.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "p99 Latency",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND_SVC}\" AND metric.type=\"run.googleapis.com/request_latencies\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_99"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 3000,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "3600s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "WARNING"
}
EOF
)"

# ─── Alert 4: Backend kein Traffic (cold-start window excluded) ───────────────
step "4/7 Alert: Backend Inaktivität"

create_alert "backend-no-traffic" "RealSync Backend — kein Traffic 10 min" "$(cat <<EOF
{
  "displayName": "RealSync Backend — kein Traffic 10 min",
  "documentation": {
    "content": "Cloud Run realsync-backend hat 10 Minuten lang keine Requests erhalten. Mögliches Symptom: Service nicht erreichbar oder DNS-Problem.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "No Requests",
      "conditionAbsent": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${BACKEND_SVC}\" AND metric.type=\"run.googleapis.com/request_count\"",
        "aggregations": [
          {
            "alignmentPeriod": "600s",
            "perSeriesAligner": "ALIGN_COUNT"
          }
        ],
        "duration": "600s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "7200s"
  },
  "combiner": "OR",
  "enabled": false,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "WARNING"
}
EOF
)"

# ─── Alert 5: Gateway 5xx Fehlerrate ─────────────────────────────────────────
step "5/7 Alert: Gateway 5xx Fehlerrate"

create_alert "gateway-5xx-rate" "RealSync Gateway — 5xx Fehlerrate > 2%" "$(cat <<EOF
{
  "displayName": "RealSync Gateway — 5xx Fehlerrate > 2%",
  "documentation": {
    "content": "OpenClaw Gateway gibt mehr als 2% HTTP 5xx Fehler zurück.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Gateway 5xx Error Rate",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${GATEWAY_SVC}\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.02,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "WARNING"
}
EOF
)"

# ─── Alert 6: DB-Migration fehlgeschlagen (Log-basiert) ───────────────────────
step "6/7 Log-basierter Alert: DB Migration failed"

# Zuerst Log-Metrik anlegen
LOG_METRIC_NAME="realsync_db_migration_failed"
EXISTING_METRIC=$(gcloud logging metrics list \
  --project="${PROJECT}" \
  --filter="name=${LOG_METRIC_NAME}" \
  --format="value(name)" 2>/dev/null | head -1 || echo "")

if [[ -z "${EXISTING_METRIC}" ]]; then
  gcloud logging metrics create "${LOG_METRIC_NAME}" \
    --project="${PROJECT}" \
    --description="Counts failed DB migration runs in Cloud Run Job" \
    --log-filter='resource.type="cloud_run_job" resource.labels.job_name="realsync-db-migrate" severity>=ERROR'
  log "Log-Metrik erstellt: ${LOG_METRIC_NAME}"
else
  info "Log-Metrik existiert bereits: ${LOG_METRIC_NAME}"
fi

create_alert "db-migration-failed" "RealSync — DB Migration fehlgeschlagen" "$(cat <<EOF
{
  "displayName": "RealSync — DB Migration fehlgeschlagen",
  "documentation": {
    "content": "Ein Cloud Run Job (realsync-db-migrate) hat ERROR-Level-Logs erzeugt. Migration sofort prüfen.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "DB Migration Error Logs",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/${LOG_METRIC_NAME}\" AND resource.type=\"cloud_run_job\"",
        "aggregations": [
          {
            "alignmentPeriod": "60s",
            "perSeriesAligner": "ALIGN_COUNT",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "86400s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "CRITICAL"
}
EOF
)"

# ─── Alert 7: Dead-Letter Queue (Log-basiert) ──────────────────────────────────
step "7/7 Log-basierter Alert: Dead-Letter Queue"

DLQ_METRIC_NAME="realsync_dlq_jobs"
EXISTING_DLQ=$(gcloud logging metrics list \
  --project="${PROJECT}" \
  --filter="name=${DLQ_METRIC_NAME}" \
  --format="value(name)" 2>/dev/null | head -1 || echo "")

if [[ -z "${EXISTING_DLQ}" ]]; then
  gcloud logging metrics create "${DLQ_METRIC_NAME}" \
    --project="${PROJECT}" \
    --description="Counts jobs landing in BullMQ dead-letters queue" \
    --log-filter='resource.type="cloud_run_revision" resource.labels.service_name="realsync-backend" jsonPayload.queue="dead-letters"'
  log "Log-Metrik erstellt: ${DLQ_METRIC_NAME}"
else
  info "Log-Metrik existiert bereits: ${DLQ_METRIC_NAME}"
fi

create_alert "dlq-jobs" "RealSync — BullMQ Dead-Letter Queue > 0" "$(cat <<EOF
{
  "displayName": "RealSync — BullMQ Dead-Letter Queue > 0",
  "documentation": {
    "content": "Ein oder mehrere Jobs sind in der Dead-Letter Queue gelandet. Worker-Logs prüfen: gcloud run services logs read realsync-backend --region ${REGION}",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Dead Letter Queue Jobs",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/${DLQ_METRIC_NAME}\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_COUNT",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "3600s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"],
  "severity": "WARNING"
}
EOF
)"

# ─── Zusammenfassung ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Monitoring Setup abgeschlossen!${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Notification Channel : ${BLUE}${CHANNEL_ID}${NC}"
echo -e "  Alert-E-Mail         : ${BLUE}${ALERT_EMAIL}${NC}"
echo ""
echo -e "Alerts im GCP Console:"
echo -e "  ${BLUE}https://console.cloud.google.com/monitoring/alerting?project=${PROJECT}${NC}"
echo ""
echo -e "${YELLOW}Hinweis:${NC} Backend-Inaktivitäts-Alert ist deaktiviert (enabled=false)."
echo -e "  Aktivieren nach Produktions-Traffic mit:"
echo -e "  gcloud alpha monitoring policies update <POLICY_ID> --project=${PROJECT}"
echo ""
