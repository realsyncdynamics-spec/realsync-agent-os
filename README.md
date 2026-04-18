# RealSyncDynamics Agent-OS

[![Node.js 20](https://img.shields.io/badge/Node.js-20_LTS-green?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)](https://docker.com)
[![EU AI Act](https://img.shields.io/badge/EU_AI_Act-konform-yellow)](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)

**Multi-Tenant AI-Agenten-Orchestrierungsplattform** für KMU, Schulen und Behörden.  
EU-AI-Act-konform (RL 2024/1689) | DSGVO-ready | OpenClaw Execution Layer

---

## Repository-Struktur

```
realsync-agent-os/
├── backend/                    ← Express API + AI-Manager + Agent-Services
│   ├── src/
│   │   ├── app.js              ← Express-Hauptapp (Entry Point)
│   │   ├── ai-manager.js       ← AI-Orchestrator (BullMQ + LangChain.js)
│   │   ├── openclaw-client.js  ← OpenClaw Gateway HTTP/WS Client
│   │   ├── agents/
│   │   │   └── devops-agent.js ← DevOps-Agent Microservice
│   │   ├── routes/
│   │   │   ├── workflows.js    ← Workflow CRUD + execute/pause/resume/approve
│   │   │   ├── tasks.js        ← Task + AgentRun Queries
│   │   │   ├── gateways.js     ← OpenClaw Gateway Management
│   │   │   ├── compliance.js   ← EU-AI-Act Compliance Reports
│   │   │   ├── billing.js      ← Stripe Subscriptions + Portal
│   │   │   └── stripe-webhook.js ← Stripe Event Handler
│   │   ├── middleware/
│   │   │   ├── auth.js         ← JWT Verification
│   │   │   ├── audit.js        ← EU AI Act Art. 12 Audit-Log
│   │   │   └── plan-limits.js  ← Plan-Limit Enforcement
│   │   ├── config/
│   │   │   └── plans.js        ← Free/Starter/Professional/Enterprise
│   │   └── db/
│   │       ├── index.js        ← PostgreSQL Pool + helpers
│   │       └── schema.sql      ← 8 Tabellen, ENUMs, RLS, GIN-Indizes
│   ├── Dockerfile              ← Cloud Run ready (Node 20 Alpine)
│   └── package.json
│
├── gateway/                    ← OpenClaw Gateway Service (auf Kunden-Servern)
│   ├── src/
│   │   ├── server.js           ← Express + WebSocket Server
│   │   ├── job-runner.js       ← Async Script-Execution mit Streaming
│   │   ├── auth.js             ← Timing-safe API-Key Validation
│   │   ├── system-info.js      ← CPU/RAM/Disk Metriken
│   │   └── logger.js           ← Winston Logger
│   ├── scripts/
│   │   ├── install-linux.sh    ← One-Liner Installer (systemd Service)
│   │   └── install-windows.ps1 ← PowerShell Installer (NSSM/Task Scheduler)
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── README.md               ← Gateway-spezifische Doku
│
├── flutterflow/                ← FlutterFlow Frontend-Anbindung
│   ├── api_connector.json      ← 24 API-Call-Definitionen (importierbar)
│   ├── data_types.json         ← 7 Custom Data Types
│   └── SETUP_GUIDE.md          ← Schritt-für-Schritt Anleitung
│
├── scripts/                    ← Bash-Scripts für OpenClaw-Execution
│   ├── system_health_check.sh
│   ├── log_anomaly_scan.sh
│   └── backup_verify.sh
│
├── playbooks/                  ← Agent-Workflow-Definitionen (JSON)
│   ├── daily_health_check.json
│   ├── weekly_social_post.json
│   └── log_anomaly_alert.json
│
├── .github/workflows/
│   └── deploy.yml              ← CI/CD → Google Cloud Run (europe-west1)
└── .env.example
```

---

## Quick Start

### Backend (5 Schritte)

```bash
# 1. Klonen
git clone https://github.com/realsyncdynamics-spec/realsync-agent-os.git
cd realsync-agent-os

# 2. Env konfigurieren
cp .env.example backend/.env
# → DATABASE_URL, REDIS_URL, JWT_SECRET, OPENAI_API_KEY, STRIPE_* ausfüllen

# 3. Datenbank migrieren
psql $DATABASE_URL -f backend/src/db/schema.sql

# 4. Dependencies & Start
cd backend && npm install && npm run dev

# 5. Health-Check
curl http://localhost:3000/health
```

### OpenClaw Gateway (Linux, ein Befehl)

```bash
curl -fsSL https://raw.githubusercontent.com/realsyncdynamics-spec/realsync-agent-os/main/gateway/scripts/install-linux.sh | bash
```

### OpenClaw Gateway (Docker)

```bash
cd gateway
cp .env.example .env  # GATEWAY_API_KEY setzen
docker compose up -d
```

### OpenClaw Gateway (Windows)

```powershell
irm https://raw.githubusercontent.com/realsyncdynamics-spec/realsync-agent-os/main/gateway/scripts/install-windows.ps1 | iex
```

---

## Architektur

```
┌─────────────────────────────────────────────────────────────────────┐
│                    RealSyncDynamics Agent-OS                        │
├─────────────┬──────────────────┬──────────────┬────────────────────┤
│  Frontend   │  Backend / API   │  AI-Manager  │  Agent-Layer       │
│  FlutterFlow│  Node.js 20      │  LangChain   │  DevOps            │
│  Web+Mobile │  Express 4       │  GPT-4o      │  Marketing         │
│  24 API     │  PostgreSQL 16   │  BullMQ      │  Compliance        │
│  Calls      │  Row Level Sec.  │  Risk-Class. │  Research          │
├─────────────┴──────────────────┴──────────────┴────────────────────┤
│  OpenClaw Gateway Layer (auf Kunden-Servern)                        │
│  Node.js + WebSocket | Docker / systemd / NSSM                      │
│  Linux · Windows · VPS · On-Prem | API-Key Auth + TLS              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Pläne & Limits

| Plan | Preis | Workflows | Gateways | Agent-Runs/Monat | Compliance |
|---|---|---|---|---|---|
| Free | €0 | 3 | 1 | 100 | ✗ |
| Starter | €29 | 25 | 5 | 2.500 | ✓ |
| Professional | €99 | 100 | 20 | 15.000 | ✓ |
| Enterprise | Custom | ∞ | ∞ | ∞ | ✓ |

---

## EU-AI-Act Compliance

| Artikel | Anforderung | Implementierung |
|---|---|---|
| Art. 5 | Verbotene KI-Praktiken | `AIManager.classifyRisk()` blockiert PROHIBITED |
| Art. 9 | Risikomanagementsystem | LLM-basierte Risk-Klassifizierung (minimal/limited/high) |
| Art. 12 | Logging & Aufzeichnung | `audit_logs`-Tabelle (unveränderlich) + Audit-Middleware |
| Art. 14 | Human Oversight | `human_approval_required`-Flag + `/approve`-Endpoint |
| Art. 50 | Transparenzpflichten | KI-generierter Inhalt maschinenlesbar gekennzeichnet |

---

## Deployment (Google Cloud Run)

Push auf `main` → GitHub Actions → Docker Build → Cloud Run `europe-west1`

GitHub Secrets benötigt: `GCP_PROJECT_ID`, `GCP_SA_KEY`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

Details: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)

---

## FlutterFlow Integration

Importiere [`flutterflow/api_connector.json`](flutterflow/api_connector.json) direkt in FlutterFlow (Settings → API Calls → Import).  
Anleitung: [`flutterflow/SETUP_GUIDE.md`](flutterflow/SETUP_GUIDE.md)

---

## License

MIT © 2026 RealSyncDynamics
