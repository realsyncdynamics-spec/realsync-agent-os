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

Ein grüner Workflow allein reicht nicht — die Services müssen live getestet werden.

**Service-URLs (deterministisch, Projektnummer `285969423992`):**

| Service | URL |
|---|---|
| Backend | `https://realsync-backend-285969423992.europe-west1.run.app` |
| Gateway | `https://realsync-gateway-285969423992.europe-west1.run.app` |

Cloud Run vergibt diese URLs nach dem Muster `<service>-<projektnummer>.<region>.run.app` — sie sind stabil über Deployments hinweg. Alternativ per `gcloud` ermitteln (die Workflow-Logs haben nur ~90 Tage Retention):

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

### "denied: This API method requires billing to be enabled"
Der Docker-Push nach Artifact Registry bricht ab mit:
> `denied: This API method requires billing to be enabled. Please enable billing on project #285969423992`

**Ursache:** Die Rechnungsstellung des GCP-Projekts ist deaktiviert (abgelaufene Karte, Budget-Stopp, Testguthaben erschöpft). Das betrifft nicht nur den Deploy — **auch die bereits laufenden Cloud-Run-Services stellen den Dienst ein.**

**Symptom-Check ohne `gcloud`:** Die Service-URLs liefern HTTP 500/503 (Googles generische Fehlerseite, nicht die App). Zur Abgrenzung: ein *nicht existierender* Service liefert unter demselben URL-Muster 404. 503 statt 404 heißt also „Service existiert, kann aber nicht ausliefern" — typisch für gestopptes Billing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://realsync-backend-285969423992.europe-west1.run.app/health
# 200 = gesund | 500/503 = Billing/Serving-Problem | 404 = Service existiert nicht
```

**Behebung:** Billing im [GCP-Console-Billing](https://console.developers.google.com/billing/enable?project=285969423992) reaktivieren, einige Minuten auf Propagierung warten, dann den fehlgeschlagenen Deploy-Run über die Actions-UI neu starten (*Re-run failed jobs*) und mit `scripts/smoke_test.sh` verifizieren.

### "workflow_dispatch: 403 Resource not accessible by integration"
Der Deploy-Workflow lässt sich per GitHub App / Automation nur triggern, wenn die App die Berechtigung **Actions: Read and write** besitzt. In den Organisations-Einstellungen der GitHub App ergänzen — oder den Run manuell über die Actions-UI starten (`Deploy to Cloud Run` → *Run workflow*).
