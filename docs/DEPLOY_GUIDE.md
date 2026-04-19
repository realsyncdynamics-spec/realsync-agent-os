# RealSync Agent-OS — Cloud Run Deploy Guide

> **Infrastruktur-Realität:** Nichts gilt als fertig, bevor es live getestet wurde.

---

## Voraussetzungen

| Tool | Version | Prüfen |
|---|---|---|
| `gcloud` CLI | latest | `gcloud version` |
| `gh` CLI | latest | `gh version` |
| Docker | 24+ | `docker version` |
| Node.js | 20 LTS | `node --version` |
| `jq` | any | `jq --version` |
| `openssl` | any | `openssl version` |

---

## Sprint 9 — Erster Live-Deploy (5 Befehle)

Das ist der einzige manuelle Schritt. Alles andere erledigt `bootstrap_deploy.sh` automatisch.

### Schritt 1 — Authentifizieren

```bash
gcloud auth login
gh auth login
```

### Schritt 2 — Pflicht-Variablen setzen

```bash
export GCP_PROJECT_ID="realsync-prod-001"          # deine GCP Project ID

export DATABASE_URL="postgresql://USER:PASS@HOST/DB"  # Cloud SQL oder Neon/Supabase
export REDIS_URL="redis://default:PASS@HOST:6379"     # Memorystore oder Upstash

export OPENAI_API_KEY="sk-..."
export STRIPE_SECRET_KEY="sk_live_..."     # sk_test_... für Staging
export STRIPE_WEBHOOK_SECRET="whsec_..."
```

### Schritt 3 — Bootstrap ausführen

```bash
bash scripts/bootstrap_deploy.sh
```

Was das Script automatisch erledigt:
- GCP APIs aktivieren (Cloud Run, Artifact Registry, Secret Manager, IAM)
- Artifact Registry Repository `realsync-agent-os` anlegen
- Deployer Service Account `realsync-deployer@...` + IAM-Rollen
- Alle 11 Secrets in Secret Manager befüllen
- GitHub Secrets `GCP_PROJECT_ID`, `GCP_SA_KEY`, `GCP_DEPLOY_SA` setzen
- GitHub Environment `production` anlegen
- Ersten Deploy via leerem Commit triggern

### Schritt 4 — Pipeline freigeben

1. [GitHub Actions öffnen](https://github.com/realsyncdynamics-spec/realsync-agent-os/actions)
2. Laufenden Workflow anklicken
3. **"Review deployments"** → `production` → **"Approve and deploy"**
4. Warten bis alle 7 Jobs grün sind (~8–12 min)

### Schritt 5 — Smoke-Test

```bash
bash scripts/smoke_test.sh \
  $(gcloud run services describe realsync-backend \
    --region europe-west1 \
    --format 'value(status.url)')
```

Erwartet: 6/6 Tests grün, alle HTTP 200, Antwortzeit < 2 s.

---

## Lokaler Stack (vor dem Deploy)

```bash
# Vollständigkeit prüfen
bash scripts/preflight_check.sh

# Stack starten
docker compose up -d

# Mit SMTP-Catcher (Mailpit → http://localhost:8025)
docker compose --profile dev up -d

# Stack stoppen
docker compose down -v
```

---

## Externes Datenbank-Setup

### Option A — Neon (empfohlen, kostenlos bis 3 GB)

```
https://neon.tech → New Project → Europe (Frankfurt) → Connection string kopieren
Format: postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

### Option B — Supabase

```
https://supabase.com → New project → Frankfurt → Settings → Database → Connection string
Format: postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres
```

### Option C — Google Cloud SQL (Produktion)

```bash
gcloud sql instances create realsync-db \
  --database-version=POSTGRES_16 \
  --region=europe-west1 \
  --tier=db-f1-micro \
  --storage-size=10GB \
  --project=$GCP_PROJECT_ID

gcloud sql users set-password postgres \
  --instance=realsync-db \
  --password="SICHERES_PASSWORT" \
  --project=$GCP_PROJECT_ID

# Cloud SQL Proxy URL für Cloud Run:
# postgresql://postgres:PASS@/DATABASE?host=/cloudsql/PROJECT:europe-west1:realsync-db
```

## Externes Redis-Setup

### Option A — Upstash (empfohlen, kostenlos bis 10.000 req/Tag)

```
https://upstash.com → Create Database → Frankfurt → TLS aktivieren
Format: rediss://default:PASS@proud-xxx.upstash.io:6379
```

### Option B — Google Memorystore

```bash
gcloud redis instances create realsync-redis \
  --size=1 \
  --region=europe-west1 \
  --project=$GCP_PROJECT_ID
# Erfordert VPC Connector für Cloud Run
```

---

## Nach dem ersten Deploy

### Stripe Webhook registrieren

```bash
# Produktions-Webhook URL eintragen
# → https://dashboard.stripe.com/webhooks
# URL: https://DEINE-BACKEND-URL/webhooks/stripe
# Events: payment_intent.succeeded, customer.subscription.*, invoice.*
```

### GitHub Environment absichern

In GitHub → Settings → Environments → production:
- **Required reviewers**: dich selbst eintragen
- **Deployment branches**: `main` only
- **Wait timer**: optional (z.B. 2 min für Überprüfung)

> Jeder Deploy muss manuell freigegeben werden — erfüllt EU AI Act Art. 14 (Human Oversight).

---

## Monitoring & Logs

```bash
# Backend Logs (live)
gcloud run services logs tail realsync-backend \
  --region europe-west1 --project $GCP_PROJECT_ID

# Gateway Logs
gcloud run services logs tail realsync-gateway \
  --region europe-west1 --project $GCP_PROJECT_ID

# DB Migration Logs
gcloud run jobs executions list \
  --job=realsync-db-migrate \
  --region=europe-west1 \
  --project=$GCP_PROJECT_ID

# Health-Endpoints
curl https://BACKEND-URL/health        # Liveness
curl https://BACKEND-URL/health/ready  # Readiness (DB + Redis)
curl https://BACKEND-URL/health/deep \
  -H "X-Health-Key: $INTERNAL_HEALTH_KEY"  # Deep (alle Subsysteme)
```

---

## Troubleshooting

### "Permission denied on Artifact Registry"
```bash
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
  --member="serviceAccount:realsync-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

### "Container failed to start"
```bash
gcloud run services logs read realsync-backend \
  --region europe-west1 --project $GCP_PROJECT_ID --limit 50
```

### Health Check schlägt fehl (DB nicht erreichbar)
```bash
# Secret prüfen
gcloud secrets versions access latest \
  --secret=DATABASE_URL --project=$GCP_PROJECT_ID

# Cloud SQL: Service Account braucht roles/cloudsql.client
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
  --member="serviceAccount:realsync-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
```

### Secret nicht gefunden
```bash
gcloud secrets list --project=$GCP_PROJECT_ID
gcloud secrets versions access latest --secret=JWT_SECRET --project=$GCP_PROJECT_ID
```

---

## Workload Identity Federation (empfohlen nach erstem Deploy)

Ersetzt den JSON-SA-Key durch tokenbasierte Authentifizierung — keine langlebigen Keys mehr.

```bash
# In terraform/wif.tf bereits vorbereitet
cd terraform
terraform init
terraform apply -target=google_iam_workload_identity_pool.github
```

Dann in `.github/workflows/deploy.yml` die auskommentierten WIF-Zeilen aktivieren und `GCP_SA_KEY` aus GitHub Secrets löschen.

---

## Kostenübersicht (Schätzung europe-west1)

| Ressource | Konfiguration | Monatlich |
|---|---|---|
| Cloud Run Backend | 0–10 Instanzen, 512 Mi | €0–15 |
| Cloud Run Gateway | 0–5 Instanzen, 256 Mi | €0–8 |
| Artifact Registry | ~2 GB Images | ~€0.20 |
| Secret Manager | 11 Secrets | ~€0.06 |
| **Gesamt bei 0 Traffic** | | **~€0.26** |
| **Gesamt bei aktivem Betrieb** | | **€5–25** |

> Kosten steigen linear mit Traffic. Cold-Start nach Inaktivität: ~2 s (Node.js auf Alpine).
