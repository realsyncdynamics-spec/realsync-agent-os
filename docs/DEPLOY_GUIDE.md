# RealSync Agent-OS — Cloud Run Deploy Guide

**Infrastruktur-Realität:** Nichts gilt als fertig, bevor es live getestet wurde.

---

## Voraussetzungen

| Tool | Version | Prüfen |
|---|---|---|
| `gcloud` CLI | latest | `gcloud version` |
| `gh` CLI | latest | `gh version` |
| Docker | 24+ | `docker version` |
| Node.js | 20 LTS | `node --version` |

---

## Schritt 1 — GCP einrichten (einmalig)

```bash
# GCP Project ID setzen (ersetze mit deiner echten Project ID)
export GCP_PROJECT_ID=realsync-prod-001

# Setup-Script ausführen
bash scripts/gcp_setup.sh
```

Das Script erledigt automatisch:
- Cloud Run, Artifact Registry, Secret Manager, IAM APIs aktivieren
- Artifact Registry Repository `realsync-agent-os` anlegen
- Deployer Service Account `realsync-deployer@...` erstellen
- IAM-Rollen zuweisen: `run.admin`, `artifactregistry.writer`, `secretAccessor`, `serviceAccountUser`
- Secret Manager Platzhalter für alle 11 Secrets anlegen
- Service Account JSON Key ausgeben

---

## Schritt 2 — GitHub Secrets setzen

In deinem GitHub Repo → **Settings → Secrets and variables → Actions**:

| Secret Name | Wert | Quelle |
|---|---|---|
| `GCP_PROJECT_ID` | deine GCP Project ID | z.B. `realsync-prod-001` |
| `GCP_SA_KEY` | JSON-Inhalt des SA-Keys | Ausgabe von `gcp_setup.sh` |
| `GCP_DEPLOY_SA` | `realsync-deployer@{PROJECT_ID}.iam.gserviceaccount.com` | Ausgabe von `gcp_setup.sh` |

```bash
# Alternativ via gh CLI:
gh secret set GCP_PROJECT_ID --body "realsync-prod-001"
gh secret set GCP_SA_KEY < /tmp/realsync-sa-key-*.json
gh secret set GCP_DEPLOY_SA --body "realsync-deployer@realsync-prod-001.iam.gserviceaccount.com"
```

---

## Schritt 3 — Secret Manager Werte befüllen

Jeden Platzhalter mit dem echten Wert ersetzen:

```bash
export PROJECT_ID=realsync-prod-001

# Beispiel — DATABASE_URL (Cloud SQL Postgres 16)
echo -n "postgresql://realsync:PASSWORT@/realsync_db?host=/cloudsql/PROJECT:europe-west1:realsync-db" | \
  gcloud secrets versions add DATABASE_URL --data-file=- --project=$PROJECT_ID

# REDIS_URL (Memorystore oder Upstash)
echo -n "rediss://default:PASSWORT@DEINE-REDIS-HOST:6380" | \
  gcloud secrets versions add REDIS_URL --data-file=- --project=$PROJECT_ID

# JWT_SECRET (mindestens 64 Zeichen zufällig)
openssl rand -hex 64 | \
  gcloud secrets versions add JWT_SECRET --data-file=- --project=$PROJECT_ID

# JWT_REFRESH_SECRET
openssl rand -hex 64 | \
  gcloud secrets versions add JWT_REFRESH_SECRET --data-file=- --project=$PROJECT_ID

# AGENT_INTERNAL_KEY (für X-Agent-Key Header)
openssl rand -hex 32 | \
  gcloud secrets versions add AGENT_INTERNAL_KEY --data-file=- --project=$PROJECT_ID

# GATEWAY_SECRET
openssl rand -hex 32 | \
  gcloud secrets versions add GATEWAY_SECRET --data-file=- --project=$PROJECT_ID

# INTERNAL_HEALTH_KEY (für /health/deep Endpoint)
openssl rand -hex 32 | \
  gcloud secrets versions add INTERNAL_HEALTH_KEY --data-file=- --project=$PROJECT_ID

# OPENAI_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, OPENCLAW_API_KEY
# → aus den jeweiligen Dashboards kopieren
```

---

## Schritt 4 — GitHub Environment einrichten

In deinem GitHub Repo → **Settings → Environments → New environment → `production`**:

1. **Required reviewers** → dich selbst hinzufügen
2. **Deployment branches** → `main` only (Selected branches)
3. Speichern

> Jeder Deploy auf `main` muss jetzt manuell freigegeben werden — das erfüllt EU AI Act Art. 14 (Human Oversight) für den Deploymentprozess selbst.

---

## Schritt 5 — Erster Deploy

```bash
# Kleines Update pushen um die Pipeline auszulösen
cd /path/to/realsync-agent-os
git commit --allow-empty -m "chore: trigger first Cloud Run deploy"
git push origin main
```

Dann in GitHub → **Actions** → laufenden Workflow öffnen → **Review deployments** → `production` freigeben.

---

## Smoke-Test nach Deploy

```bash
# Service URL holen
export SERVICE_URL=$(gcloud run services describe realsync-backend \
  --region europe-west1 --format 'value(status.url)')

# Liveness
curl -sf "$SERVICE_URL/health" | jq .

# Readiness (DB + Redis)
curl -sf "$SERVICE_URL/health/ready" | jq .

# Auth-Endpoint erreichbar
curl -sf -X POST "$SERVICE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!","name":"Test","tenantName":"TestCo"}' | jq .
```

Erwartete Liveness-Antwort:
```json
{
  "status": "ok",
  "service": "realsync-backend",
  "version": "1.3.0",
  "eu_ai_act_compliant": true,
  "uptime_s": 12,
  "timestamp": "2026-04-18T21:05:00.000Z"
}
```

---

## Troubleshooting

### Deploy schlägt fehl: "Permission denied on Artifact Registry"
```bash
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
  --member="serviceAccount:realsync-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

### Cloud Run: "Container failed to start"
```bash
# Logs in Echtzeit
gcloud run services logs read realsync-backend \
  --region europe-west1 --project $GCP_PROJECT_ID --limit 50
```

### Health Check schlägt fehl (DB nicht erreichbar)
- Cloud SQL: Service Account braucht `roles/cloudsql.client`
- VPC Connector prüfen falls Postgres nicht öffentlich
- `DATABASE_URL` in Secret Manager prüfen: `gcloud secrets versions access latest --secret=DATABASE_URL`

### Secret nicht gefunden
```bash
# Alle Secrets auflisten
gcloud secrets list --project=$GCP_PROJECT_ID

# Spezifischen Wert prüfen
gcloud secrets versions access latest --secret=JWT_SECRET --project=$GCP_PROJECT_ID
```

---

## Workload Identity Federation (empfohlen für Produktion)

Wenn JSON-Keys vermieden werden sollen:

```bash
export USE_WORKLOAD_IDENTITY=true
export GITHUB_REPO=realsyncdynamics-spec/realsync-agent-os
bash scripts/gcp_setup.sh
```

Dann in `.github/workflows/deploy.yml` die auskommentierten WIF-Zeilen aktivieren.

---

## Kostenübersicht (Schätzung)

| Ressource | Menge | Monatlich (geschätzt) |
|---|---|---|
| Cloud Run Backend | 0-10 Instanzen, 512Mi | €0–15 |
| Cloud Run Gateway | 0-5 Instanzen, 256Mi | €0–8 |
| Artifact Registry | ~2 GB Images | ~€0.20 |
| Secret Manager | 11 Secrets | ~€0.06 |
| **Gesamt** | | **€0–25/Monat** |

> Kosten steigen linear mit Traffic. Bei 0 Requests: ~€0.26/Monat (Storage only).
