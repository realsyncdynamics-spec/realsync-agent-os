# RealSync Agent-OS

[![CI](https://github.com/realsyncdynamics-spec/realsync-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/realsyncdynamics-spec/realsync-agent-os/actions/workflows/ci.yml)
[![Node.js 20](https://img.shields.io/badge/Node.js-20_LTS-green?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](https://docker.com)
[![EU AI Act](https://img.shields.io/badge/EU_AI_Act_2024%2F1689-konform-yellow)](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32024R1689)
[![Terraform](https://img.shields.io/badge/Terraform-1.7-purple?logo=terraform)](https://terraform.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

**EU-konformes AI-Agenten-SaaS für KMU in Deutschland.**  
Automatisiert wiederkehrende Geschäftsprozesse mit nachvollziehbaren KI-Entscheidungen, menschlicher Freigabe und vollständigem Audit-Log.

> Zielgruppe: KMU Deutschland, 5–50 Mitarbeiter | Plans: Free · €29 · €99/Monat

---

## Die drei MVP-Playbooks

| Playbook | Trigger | EU AI Act | Status |
|---|---|---|---|
| **Daily Health Check** | Täglich 06:00 UTC | Minimal Risk | ✅ Produktionsbereit |
| **Backup Verification** | Täglich 07:00 Berlin | Minimal Risk | ✅ Produktionsbereit |
| **Invoice-to-Archive** | E-Mail / Webhook | Limited Risk (Art. 50) | ✅ Produktionsbereit |

---

## Quick Start (lokal)

```bash
# 1. Repo klonen
git clone https://github.com/realsyncdynamics-spec/realsync-agent-os.git
cd realsync-agent-os

# 2. Environment konfigurieren
cp .env.example .env
# → .env öffnen und Werte eintragen (mindestens DATABASE_URL, JWT_SECRET, OPENAI_API_KEY)

# 3. PostgreSQL + Redis starten (oder lokal installiert nutzen)
docker run -d --name pg -e POSTGRES_PASSWORD=password -e POSTGRES_DB=realsync_agentdb -p 5432:5432 postgres:16-alpine
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 4. Datenbankschema einrichten
psql $DATABASE_URL -f backend/src/db/schema.sql
psql $DATABASE_URL -f backend/src/db/migrations/001_add_auth_tables.sql
psql $DATABASE_URL -f backend/src/db/migrations/002_add_approvals_table.sql
psql $DATABASE_URL -f backend/src/db/migrations/003_invoices_health_metrics.sql

# 5. Backend starten
cd backend
npm install
npm run dev

# 6. Health Check
curl http://localhost:8080/health
```

---

## Deploy auf Google Cloud Run

Vollständige Anleitung: **[docs/DEPLOY_GUIDE.md](docs/DEPLOY_GUIDE.md)**

**Kurzfassung (3 Schritte):**

```bash
# Schritt 1 — GCP einrichten (einmalig, ~15 Min)
export GCP_PROJECT_ID=dein-projekt-id
bash scripts/gcp_setup.sh
# ODER mit Terraform:
cd terraform && cp terraform.tfvars.example terraform.tfvars
# → project_id eintragen
terraform init && terraform apply

# Schritt 2 — GitHub Secrets setzen
gh secret set GCP_PROJECT_ID --body "$GCP_PROJECT_ID"
gh secret set GCP_SA_KEY < /tmp/realsync-sa-key-*.json
gh secret set GCP_DEPLOY_SA --body "realsync-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

# Schritt 3 — Deployen
git commit --allow-empty -m "chore: trigger first deploy"
git push origin main
# → In GitHub Actions: Approve den 'production' Deploy
```

Nach erfolgreichem Deploy:
```bash
SERVICE_URL=$(gcloud run services describe realsync-backend --region europe-west1 --format 'value(status.url)')
curl "$SERVICE_URL/health"        # → {"status":"ok","eu_ai_act_compliant":true,...}
curl "$SERVICE_URL/health/ready"  # → {"status":"ready","checks":{"database":...,"redis":...}}
```

---

## Repository-Struktur

```
realsync-agent-os/
├── .github/
│   └── workflows/
│       ├── ci.yml              ← CI: lint, test, Docker build, Playbook-Validierung (kein GCP nötig)
│       └── deploy.yml          ← CD: Artifact Registry → Cloud Run, Environment Gate
│
├── backend/                    ← Express API Service (Cloud Run)
│   ├── src/
│   │   ├── app.js              ← Entry Point v1.5: Routes, Workers, Graceful Shutdown
│   │   ├── agents/
│   │   │   ├── devops-agent.js      ← DevOps-Agent (system-exec, log-analyse)
│   │   │   ├── marketing-agent.js   ← Marketing-Agent (LinkedIn, Twitter, Facebook)
│   │   │   ├── compliance-agent.js  ← Compliance-Agent (EU AI Act Annex III)
│   │   │   └── research-agent.js    ← Research-Agent (web_search, market_summary)
│   │   ├── routes/
│   │   │   ├── health.js       ← /health, /health/ready, /health/deep
│   │   │   ├── auth.js         ← Register, Login, Refresh, Logout, Reset-Password
│   │   │   ├── workflows.js    ← Workflow CRUD + Execute/Pause/Resume/Approve
│   │   │   ├── tasks.js        ← Task + AgentRun Queries
│   │   │   ├── gateways.js     ← OpenClaw Gateway Management
│   │   │   ├── compliance.js   ← Compliance Reports
│   │   │   ├── billing.js      ← Stripe Subscriptions + Portal
│   │   │   ├── approvals.js    ← Human-in-the-loop (EU AI Act Art. 14)
│   │   │   ├── audit.js        ← Audit Log Query + NDJSON Export
│   │   │   └── stripe-webhook.js
│   │   ├── workers/
│   │   │   ├── approval-expiry.worker.js  ← BullMQ: Auto-expire pending approvals
│   │   │   └── worker-registry.js         ← Worker start/stop entry point
│   │   ├── queues/
│   │   │   └── index.js        ← BullMQ Queue-Definitionen (4 Queues)
│   │   ├── middleware/
│   │   │   ├── auth.js         ← JWT Verification
│   │   │   ├── audit.js        ← Audit-Log Middleware
│   │   │   ├── agent-auth.js   ← X-Agent-Key (timingSafeEqual)
│   │   │   └── plan-limits.js  ← Plan-Limit Enforcement
│   │   ├── config/
│   │   │   ├── plans.js        ← Free/Starter/Professional/Enterprise
│   │   │   └── stripe.js       ← Stripe Client v2024-06-20
│   │   └── db/
│   │       ├── index.js        ← PostgreSQL Pool
│   │       ├── schema.sql      ← Basis-Schema (8 Tabellen)
│   │       └── migrations/
│   │           ├── 001_add_auth_tables.sql          ← refresh_tokens, password_reset_tokens, scheduled_posts
│   │           ├── 002_add_approvals_table.sql       ← approvals (EU AI Act Art. 14)
│   │           └── 003_invoices_health_metrics.sql   ← invoices, health_metrics, invoice_exports
│   ├── Dockerfile              ← Node 20 Alpine, Port 8080
│   └── package.json            ← v1.3.0
│
├── gateway/                    ← OpenClaw Gateway Service (auf Kunden-Infrastruktur)
│   ├── src/                    ← Express + WebSocket, Script-Runner
│   ├── scripts/                ← Linux + Windows Installer
│   └── docker-compose.yml
│
├── flutterflow/
│   ├── api_connector.json      ← FlutterFlow API-Connector (24 Calls)
│   ├── data_types.json
│   ├── SETUP_GUIDE.md
│   └── dart/                   ← Vollständiger Dart-Export (11 Dateien, 3.971 Zeilen)
│       ├── lib/
│       │   ├── main.dart
│       │   ├── services/api_service.dart
│       │   ├── pages/          ← Login, Register, Dashboard, Workflows, Detail, Gateways
│       │   └── widgets/        ← StatusChip, WorkflowCard
│       └── pubspec.yaml
│
├── playbooks/                  ← MVP-Playbooks (eingefroren)
│   ├── daily_health_check.json ← ✅ Minimal Risk
│   ├── backup_verify.json      ← ✅ Minimal Risk
│   ├── invoice_to_archive.json ← ✅ Limited Risk (Art. 50)
│   ├── weekly_social_post.json ← (Backlog v2.0)
│   └── log_anomaly_alert.json
│
├── scripts/
│   ├── gcp_setup.sh            ← GCP One-Time Setup (SA, Artifact Registry, Secrets)
│   ├── system_health_check.sh  ← Health-Check Script (OpenClaw ausgeführt)
│   ├── backup_verify.sh        ← Backup-Verify Script
│   └── log_anomaly_scan.sh
│
├── terraform/                  ← IaC für GCP
│   ├── main.tf                 ← APIs, Artifact Registry, SA, IAM, Secrets
│   ├── variables.tf
│   ├── outputs.tf
│   ├── wif.tf                  ← Workload Identity Federation (opt-in)
│   └── terraform.tfvars.example
│
├── docs/
│   ├── DEPLOY_GUIDE.md         ← Schritt-für-Schritt Cloud Run Deploy
│   └── MVP_SCOPE.md            ← Einzige Zielgruppe, 3 Playbooks, Definition of Done
│
├── .github/workflows/
├── .env.example                ← Alle Umgebungsvariablen dokumentiert
└── README.md
```

---

## API-Übersicht

| Methode | Pfad | Auth | Beschreibung |
|---|---|---|---|
| GET | `/health` | — | Liveness (Cloud Run Probe) |
| GET | `/health/ready` | — | Readiness: DB + Redis |
| POST | `/auth/register` | — | Tenant + User anlegen |
| POST | `/auth/login` | — | JWT + Refresh Token |
| POST | `/auth/refresh` | — | Token-Rotation |
| GET | `/api/workflows` | JWT | Workflows auflisten |
| POST | `/api/workflows` | JWT | Workflow anlegen |
| POST | `/api/workflows/:id/execute` | JWT | Workflow starten |
| GET | `/api/approvals` | JWT | Offene Freigaben |
| POST | `/api/approvals/:id/approve` | JWT | Freigabe erteilen |
| POST | `/api/approvals/:id/reject` | JWT | Freigabe ablehnen |
| GET | `/api/audit` | JWT | Audit-Log (paginiert) |
| GET | `/api/audit/export` | JWT (Admin) | NDJSON Export (max 10k) |
| POST | `/agent/marketing` | X-Agent-Key | Marketing-Agent Actions |
| POST | `/agent/compliance` | X-Agent-Key | Compliance-Agent Actions |
| POST | `/agent/research` | X-Agent-Key | Research-Agent Actions |

---

## EU AI Act Konformität

| Artikel | Maßnahme | Implementierung |
|---|---|---|
| Art. 5 | Verbotene Praktiken | `compliance-agent` `scan_for_prohibited` |
| Art. 9 | Risikomanagement | Risk-Tiers in Playbooks, `assess_workflow_risk` |
| Art. 12 | Protokollierung | `audit_logs` Tabelle, Append-Only, Export |
| Art. 14 | Menschliche Aufsicht | `approvals` Route, Human-Gate in Playbooks |
| Art. 50 | Transparenzpflicht | `ai_generated: true` in allen Agent-Responses, Metadaten in Rechnungsarchiv |

---

## Entwicklung

```bash
# Tests
cd backend && npm test

# Lint
npm run lint

# Docker lokal
docker build -t realsync-backend ./backend
docker run -p 8080:8080 --env-file .env realsync-backend

# BullMQ Workers aktivieren (Redis erforderlich)
ENABLE_WORKERS=true npm start
```

---

## Lizenz

MIT — © 2026 RealSyncDynamics


