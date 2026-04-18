# RealSyncDynamics Agent-OS Backend

[![Node.js 20](https://img.shields.io/badge/Node.js-20_LTS-green?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](https://docker.com)
[![EU AI Act](https://img.shields.io/badge/EU_AI_Act-konform-yellow)](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

**Multi-Tenant AI-Agenten-Orchestrierungsplattform** für KMU, Schulen und Behörden.
EU-AI-Act-konform (RL 2024/1689) | DSGVO-ready | ISO 27001-orientiert

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                     RealSyncDynamics Agent-OS                      │
├──────────────┬────────────────────┬───────────────┬───────────────┤
│  Layer 1     │  Layer 2           │  Layer 3      │  Layer 4      │
│  Frontend    │  Backend / API     │  AI-Manager   │  Agent-Layer  │
│  FlutterFlow │  Node.js 20 +      │  LangChain.js │  DevOps       │
│  (Web+Mobile)│  Express 4         │  + GPT-4o     │  Marketing    │
│              │  PostgreSQL 16     │  BullMQ/Redis │  Compliance   │
│              │  Row Level Sec.    │  Risk-Class.  │  Research     │
├──────────────┴────────────────────┴───────────────┴───────────────┤
│  Layer 5: OpenClaw Gateway (Remote Execution)                      │
│  Node.js + SSH/REST Bridge + Docker | On-Prem oder Cloud VM        │
│  API-Key-Auth + TLS | EU-Datenresidenz                             │
└────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Voraussetzungen

- Node.js 20 LTS
- PostgreSQL 16
- Redis 7+
- Docker (für Deployment)

### 1. Repository klonen

```bash
git clone https://github.com/your-org/realsync-agent-os.git
cd realsync-agent-os
```

### 2. Environment-Variablen konfigurieren

```bash
cp .env.example .env
# Werte in .env ausfüllen (Database, Redis, OpenAI, Stripe, etc.)
```

### 3. Datenbank-Schema migrieren

```bash
cd backend
psql $DATABASE_URL -f src/db/schema.sql
```

### 4. Abhängigkeiten installieren & Server starten

```bash
npm install
npm run dev    # Entwicklung (nodemon)
# oder
npm start      # Produktion
```

### 5. Health-Check

```bash
curl http://localhost:3000/health
# → { "status": "ok", "eu_ai_act_compliant": true, ... }
```

---

## Environment Variables

| Variable | Beschreibung | Pflicht |
|---|---|---|
| `DATABASE_URL` | PostgreSQL Connection String | Ja |
| `REDIS_URL` | Redis URL für BullMQ | Ja |
| `JWT_SECRET` | JWT-Signatur-Geheimnis (min. 32 Zeichen) | Ja |
| `OPENAI_API_KEY` | OpenAI API-Schlüssel (GPT-4o) | Ja |
| `OPENAI_MODEL` | LLM-Modell (Standard: gpt-4o) | Nein |
| `STRIPE_SECRET_KEY` | Stripe Secret Key | Ja |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook Secret | Ja |
| `OPENCLAW_MASTER_KEY` | OpenClaw Gateway Master-Key | Ja |
| `PORT` | HTTP-Port (Standard: 3000) | Nein |
| `NODE_ENV` | Umgebung: development/production | Nein |
| `LOG_LEVEL` | Winston Log-Level (info/debug/warn) | Nein |
| `FRONTEND_URL` | Frontend-URL für CORS | Nein |

Vollständige Liste: [`.env.example`](.env.example)

---

## API Endpoints

### Workflows

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/workflows` | Liste aller Workflows (paginiert) |
| `POST` | `/api/workflows` | Neuen Workflow erstellen |
| `GET` | `/api/workflows/:id` | Workflow-Details |
| `PATCH` | `/api/workflows/:id` | Workflow updaten |
| `DELETE` | `/api/workflows/:id` | Soft-delete |
| `POST` | `/api/workflows/:id/execute` | Workflow starten |
| `POST` | `/api/workflows/:id/pause` | Pausieren |
| `POST` | `/api/workflows/:id/resume` | Fortsetzen |
| `POST` | `/api/workflows/:id/approve` | Human-Approval (Art. 14) |

### Tasks

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/workflows/:workflowId/tasks` | Task-Liste |
| `GET` | `/api/tasks/:id` | Task-Details |
| `GET` | `/api/tasks/:id/runs` | AgentRuns für Task |

### OpenClaw Gateways

| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/api/gateways/register` | Gateway registrieren |
| `POST` | `/api/gateways/:id/heartbeat` | Heartbeat |
| `GET` | `/api/gateways` | Alle Gateways |
| `GET` | `/api/gateways/:id` | Gateway-Details |
| `DELETE` | `/api/gateways/:id` | Deregistrieren |

### Compliance

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/compliance/reports` | Reports abrufen |
| `POST` | `/api/compliance/reports` | Report generieren |
| `GET` | `/api/compliance/reports/:id` | Report-Details |

### Webhooks & Monitoring

| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/webhooks/stripe` | Stripe-Events empfangen |
| `GET` | `/health` | Health-Check (kein Auth) |

---

## Deployment (Google Cloud Run)

### Voraussetzungen

1. GCP-Projekt mit aktivierten APIs: Cloud Run, Container Registry, Secret Manager
2. Service Account mit Berechtigungen: `Cloud Run Admin`, `Storage Admin`
3. GitHub Secrets setzen:

```
GCP_PROJECT_ID    = <your-project-id>
GCP_SA_KEY        = <service-account-json-key>
DATABASE_URL      = <cloud-sql-url>
REDIS_URL         = <redis-url>
JWT_SECRET        = <secret>
OPENAI_API_KEY    = <key>
STRIPE_SECRET_KEY = <key>
STRIPE_WEBHOOK_SECRET = <secret>
```

### Manuelles Deployment

```bash
# Docker-Image bauen
docker build -t gcr.io/$PROJECT_ID/realsync-backend:latest ./backend

# In Container Registry pushen
docker push gcr.io/$PROJECT_ID/realsync-backend:latest

# Cloud Run deployen
gcloud run deploy realsync-backend \
  --image gcr.io/$PROJECT_ID/realsync-backend:latest \
  --region europe-west1 \
  --platform managed \
  --memory 512Mi \
  --allow-unauthenticated
```

### Automatisches CI/CD

Push auf `main` → GitHub Actions → Docker Build → Cloud Run Deploy

Workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)

---

## Datenbankstruktur

8 Tabellen mit Row Level Security (Multi-Tenant):

| Tabelle | Beschreibung |
|---|---|
| `tenants` | Mandanten (KMU, Schulen, Behörden) |
| `users` | Nutzer pro Tenant (RBAC: owner/admin/member) |
| `workflows` | AI-Workflow-Definitionen (JSON-Config) |
| `tasks` | Einzelne Agent-Tasks mit Abhängigkeiten |
| `agent_runs` | LLM-Ausführungs-Logs (Tokens, Kosten, Output) |
| `openclaw_gateways` | Registrierte Execution-Gateways |
| `audit_logs` | **Unveränderliches** Audit-Log (EU AI Act Art. 12) |
| `compliance_reports` | Compliance-Berichte (EU AI Act, DSGVO) |

Schema: [`backend/src/db/schema.sql`](backend/src/db/schema.sql)

---

## OpenClaw Playbooks

Vordefinierte Automatisierungs-Workflows:

| Playbook | Trigger | Beschreibung |
|---|---|---|
| `daily_health_check` | Täglich 06:00 UTC | CPU, RAM, Disk, Services |
| `weekly_social_post` | Montags 09:00 (Berlin) | Social-Media-Automation |
| `log_anomaly_alert` | Alle 4 Stunden | Log-Anomalie-Scanning + KI-Analyse |

---

## EU-AI-Act Compliance

Dieses System implementiert die Anforderungen der **Verordnung (EU) 2024/1689 (EU AI Act)**:

| Artikel | Anforderung | Implementierung |
|---|---|---|
| Art. 5 | Verbotene KI-Praktiken | `AIManager.classifyRisk()` blockiert PROHIBITED-Workflows |
| Art. 9 | Risikomanagementsystem | Keyword-basierte + LLM-basierte Risikoklassifizierung |
| Art. 12 | Logging & Aufzeichnung | `audit_logs`-Tabelle (unveränderlich), `auditMiddleware` |
| Art. 14 | Human Oversight | `human_approval_required`-Flag, `/approve`-Endpoint |
| Art. 50 | Transparenzpflichten | KI-generierter Inhalt wird als solcher gekennzeichnet |

**Risikoklassen:** Minimal → Limited → High → Prohibited

High-Risk-Workflows erfordern obligatorische Human-Approval vor der Ausführung.

---

## Projektstruktur

```
repo/
├── backend/
│   ├── src/
│   │   ├── app.js                  # Express-Hauptapp
│   │   ├── ai-manager.js           # AI-Orchestrator (EU AI Act)
│   │   ├── openclaw-client.js      # OpenClaw Gateway Client
│   │   ├── agents/
│   │   │   └── devops-agent.js     # DevOps-Agent-Service
│   │   ├── routes/
│   │   │   ├── workflows.js        # Workflow-API
│   │   │   ├── tasks.js            # Task-API
│   │   │   ├── gateways.js         # Gateway-API
│   │   │   └── compliance.js       # Compliance-API
│   │   ├── middleware/
│   │   │   ├── auth.js             # JWT-Auth
│   │   │   └── audit.js            # Audit-Logging
│   │   └── db/
│   │       ├── index.js            # PostgreSQL Pool
│   │       └── schema.sql          # Datenbankschema
│   ├── Dockerfile
│   └── package.json
├── scripts/
│   ├── system_health_check.sh      # OpenClaw Script
│   ├── log_anomaly_scan.sh         # OpenClaw Script
│   └── backup_verify.sh            # OpenClaw Script
├── playbooks/
│   ├── daily_health_check.json     # Playbook A
│   ├── weekly_social_post.json     # Playbook B
│   └── log_anomaly_alert.json      # Playbook C
├── .github/workflows/
│   └── deploy.yml                  # Cloud Run CI/CD
├── .env.example
└── README.md
```

---

## Contributing

1. Fork erstellen
2. Feature-Branch: `git checkout -b feature/my-feature`
3. Änderungen committen: `git commit -m 'feat: add my feature'`
4. Branch pushen: `git push origin feature/my-feature`
5. Pull Request erstellen

**Code-Standards:** ESLint (Standard), Conventional Commits, JSDoc für öffentliche APIs.

---

## License

MIT License — Copyright (c) 2025 RealSyncDynamics

Dieses Projekt steht unter der [MIT-Lizenz](LICENSE). Nutzung, Modifikation und Weitergabe sind frei erlaubt, solange dieser Lizenzhinweis beibehalten wird.

---

*RealSyncDynamics Agent-OS — AI-gestützte Automatisierung, EU-konform by design.*
