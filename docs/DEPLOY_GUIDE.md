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

## Sprint 9 — WIF-basierter Deploy (One-Shot)

Der Deployment-Prozess wurde auf **Workload Identity Federation (WIF)** umgestellt. Dies ist sicherer, da keine permanenten JSON-Keys in GitHub gespeichert werden.

### Schritt 1 — Authentifizieren
```bash
gcloud auth login
gh auth login
```

### Schritt 2 — Pflicht-Variablen setzen
```bash
export GCP_PROJECT_ID="realsync-prod-001"
export DATABASE_URL="postgresql://..."
export REDIS_URL="redis://..."
export OPENAI_API_KEY="sk-..."
export STRIPE_SECRET_KEY="sk_live_..."
export STRIPE_WEBHOOK_SECRET="whsec_..."
```

### Schritt 3 — Bootstrap ausführen
```bash
bash scripts/bootstrap_deploy.sh
```

**Was das Script automatisch erledigt:**
*   Aktiviert notwendige GCP APIs (STS, IAM, Cloud Run etc.).
*   Erstellt Artifact Registry & Service Account.
*   **Setzt WIF Setup**: Erstellt Pool & Provider und verknüpft sie mit dem Repo.
*   Konfiguriert GitHub Secrets (`WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`).
*   Triggert den ersten Deploy.

### Schritt 4 — Pipeline überwachen
*   [GitHub Actions öffnen](https://github.com/realsyncdynamics-spec/realsync-agent-os/actions)
*   Der Workflow `Deploy to Cloud Run` sollte nun grün durchlaufen.

### Schritt 5 — Post-Deploy-Verifikation (Pflicht)

Ein grüner Workflow allein reicht nicht — die Services müssen live getestet werden. Die `*.run.app`-URLs stehen nur in den Workflow-Logs (Retention ~90 Tage), danach sind sie nur noch per `gcloud` ermittelbar:

```bash
export BACKEND_URL=$(gcloud run services describe realsync-backend \
  --region europe-west1 --project "$GCP_PROJECT_ID" \
  --format 'value(status.url)')
export GATEWAY_URL=$(gcloud run services describe realsync-gateway \
  --region europe-west1 --project "$GCP_PROJECT_ID" \
  --format 'value(status.url)')

bash scripts/smoke_test.sh "$BACKEND_URL"
```

Alle 6 Smoke-Test-Checks müssen grün sein (Liveness, Readiness inkl. DB, Auth-Endpoint, RFC-9457-Fehlerformat, Agent-Guard, EU-AI-Act-Label). Erst dann gilt der Deploy als fertig.

---

## Custom Domain — offener Punkt (Stand: August 2026)

Frontend-Defaults (`flutterflow/SETUP_GUIDE.md`) und Backend erwarten `https://api.realsyncdynamics.com`. **Dieser DNS-Eintrag existiert derzeit nicht** (NXDOMAIN), `staging-api` ebenfalls nicht. Die Apex-Domain `realsyncdynamics.com` zeigt zwar auf eine Google-Load-Balancer-IP, der TLS-Handshake auf Port 443 schlägt aber fehl (Zertifikat/Forwarding-Rule nicht provisioniert). Bis das behoben ist, ist die Plattform trotz grünem Deploy unter ihrer dokumentierten Adresse **nicht erreichbar**.

### Option A — Cloud Run Domain Mapping (empfohlen, einfach)
```bash
gcloud beta run domain-mappings create \
  --service realsync-backend \
  --domain api.realsyncdynamics.com \
  --region europe-west1 --project "$GCP_PROJECT_ID"
```
Danach den angezeigten DNS-Record (CNAME auf `ghs.googlehosted.com.`) beim DNS-Provider (name.com) anlegen. Das Managed Certificate wird automatisch provisioniert (~15–60 Min).

### Option B — Bestehenden HTTPS Load Balancer erweitern
Falls die Apex-LB-Infrastruktur genutzt werden soll: Serverless NEG für `realsync-backend` anlegen, Host-Regel `api.realsyncdynamics.com` im URL-Map ergänzen, Managed Certificate um die Domain erweitern und den A-Record auf die LB-IP setzen.

### Verifikation
```bash
bash scripts/smoke_test.sh https://api.realsyncdynamics.com
```

---

## Troubleshooting

### "google-github-actions/auth failed"
Falls der erste Run nach der Umstellung fehlschlägt:
1. Prüfe in GitHub Settings -> Secrets -> Actions, ob `WIF_PROVIDER` gesetzt ist.
2. Falls nicht, führe `bash scripts/bootstrap_deploy.sh` erneut aus oder setze ihn manuell (Format: `projects/NUM/locations/global/workloadIdentityPools/POOL/providers/PROVIDER`).

### "Permission denied on Artifact Registry"
Der Service Account braucht die Rolle `roles/artifactregistry.writer`. Das Bootstrap-Script setzt dies automatisch, erfordert aber `Owner` oder `Security Admin` Rechte beim Ausführenden.

### "workflow_dispatch: 403 Resource not accessible by integration"
Der Deploy-Workflow lässt sich per GitHub App / Automation nur triggern, wenn die App die Berechtigung **Actions: Read and write** besitzt. In den Organisations-Einstellungen der GitHub App ergänzen — oder den Run manuell über die Actions-UI starten (`Deploy to Cloud Run` → *Run workflow*).
