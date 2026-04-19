# RealSync Agent-OS — Produktions-Runbook

> **Prinzip:** Nichts gilt als fertig, bevor es live getestet wurde.
> Dieses Runbook beschreibt alle Betriebsprozesse nach dem ersten Deploy.

---

## Schnell-Referenz

| Dienst | URL | Logs |
|---|---|---|
| Backend | `gcloud run services describe realsync-backend --region europe-west1 --format 'value(status.url)'` | `gcloud run services logs tail realsync-backend --region europe-west1` |
| Gateway | `gcloud run services describe realsync-gateway --region europe-west1 --format 'value(status.url)'` | `gcloud run services logs tail realsync-gateway --region europe-west1` |
| Monitoring | [GCP Alerting](https://console.cloud.google.com/monitoring/alerting) | — |
| GitHub Actions | [Actions](https://github.com/realsyncdynamics-spec/realsync-agent-os/actions) | — |

```bash
# Basis-Variablen für alle Befehle in diesem Runbook
export PROJECT=realsync-prod-001
export REGION=europe-west1
export BACKEND=$(gcloud run services describe realsync-backend \
  --region $REGION --project $PROJECT --format 'value(status.url)')
```

---

## Incident-Response

### Severity-Definitionen

| Severity | Definition | Reaktionszeit |
|---|---|---|
| P0 — Critical | Service vollständig nicht erreichbar | < 15 min |
| P1 — High | >5% Fehlerrate, Datenverlust möglich | < 1 h |
| P2 — Medium | Degradierter Service, kein Datenverlust | < 4 h |
| P3 — Low | Cosmetic, Einzelfehler | nächster Werktag |

---

### Incident-Checkliste (alle Severities)

```
[ ] 1. Alarmart identifizieren (GCP Alert-Mail lesen)
[ ] 2. Logs ziehen (siehe unten)
[ ] 3. Umfang eingrenzen: Backend? Gateway? DB? Redis? AI?
[ ] 4. Letzten Deploy prüfen (war vor dem Incident ein Deploy?)
[ ] 5. Maßnahme ergreifen (Rollback / Hotfix / Restart)
[ ] 6. Bestätigen: smoke_test.sh grün
[ ] 7. Post-mortem schreiben (P0/P1 verpflichtend)
```

---

## Häufige Incidents

### P0 — Backend nicht erreichbar

```bash
# 1. Service-Status
gcloud run services describe realsync-backend \
  --region $REGION --project $PROJECT

# 2. Letzte 50 Fehler-Logs
gcloud run services logs read realsync-backend \
  --region $REGION --project $PROJECT \
  --limit 50 --filter "severity>=ERROR"

# 3. Health direkt testen
curl -sf $BACKEND/health || echo "NICHT ERREICHBAR"

# 4. Letzten erfolgreichen Revision identifizieren
gcloud run revisions list \
  --service realsync-backend \
  --region $REGION --project $PROJECT \
  --sort-by "~createTime" --limit 5
```

**Schnellrollback:**
```bash
# Letzten stabilen Revision-Namen eintragen
PREV_REVISION="realsync-backend-00XX-abc"
gcloud run services update-traffic realsync-backend \
  --region $REGION --project $PROJECT \
  --to-revisions $PREV_REVISION=100
```

---

### P1 — Hohe 5xx Fehlerrate

```bash
# Fehler-Logs mit Stack-Traces
gcloud logging read \
  "resource.type=cloud_run_revision \
   resource.labels.service_name=realsync-backend \
   severity>=ERROR \
   timestamp>=\"$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                  date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)\"" \
  --project $PROJECT \
  --format "value(textPayload,jsonPayload)" \
  --limit 100

# Fehlerrate der letzten 5 Minuten
gcloud monitoring metrics list \
  --filter "metric.type=run.googleapis.com/request_count" \
  --project $PROJECT 2>/dev/null | head -20

# DB-Readiness prüfen
curl -sf $BACKEND/health/ready | python3 -m json.tool
```

**Wenn DB-Verbindung fehlschlägt:**
```bash
# Secret prüfen
gcloud secrets versions access latest \
  --secret=DATABASE_URL --project $PROJECT

# Cloud SQL: Instanz-Status
gcloud sql instances list --project $PROJECT

# Cloud SQL: Verbindungen und Last
gcloud sql instances describe realsync-db \
  --project $PROJECT --format "value(settings.ipConfiguration)"
```

---

### P1 — DB-Migration fehlgeschlagen

```bash
# Migration-Job-Status
gcloud run jobs executions list \
  --job=realsync-db-migrate \
  --region=$REGION --project=$PROJECT \
  --limit=3

# Logs des letzten Runs
gcloud run jobs executions describe \
  $(gcloud run jobs executions list \
    --job=realsync-db-migrate \
    --region=$REGION --project=$PROJECT \
    --format="value(name)" --limit=1) \
  --region=$REGION --project=$PROJECT

# Migration manuell neu starten
gcloud run jobs execute realsync-db-migrate \
  --region=$REGION --project=$PROJECT --wait
```

---

### P2 — Hohe Latenz (p99 > 3s)

Mögliche Ursachen und Prüfbefehle:

```bash
# 1. DB-Abfragezeit aus /health/deep
curl -sf $BACKEND/health/deep \
  -H "X-Internal-Key: $(gcloud secrets versions access latest \
    --secret=INTERNAL_HEALTH_KEY --project=$PROJECT)" \
  | python3 -m json.tool

# 2. Redis-Latenz
# (Upstash: Dashboard → Latency Graph)
# (Memorystore: GCP Monitoring → redis.googleapis.com/stats/connected_clients)

# 3. BullMQ Queue-Tiefe (hohe Warteschlange = Worker überlastet)
# → /api/v1/health/deep zeigt queue_stats wenn implementiert
# → Alternativ: Redis CLI LLEN bull:agent-tasks:wait

# 4. Zu wenig Instanzen (Cold Start bei 0 min-instances)
gcloud run services update realsync-backend \
  --region $REGION --project $PROJECT \
  --min-instances 1   # temporär, kostet ~€3/Monat mehr
```

---

### P2 — BullMQ Dead-Letter Queue > 0

```bash
# 1. Welche Jobs sind in der DLQ?
# GCP Logging für dead-letters queue
gcloud logging read \
  "resource.type=cloud_run_revision \
   resource.labels.service_name=realsync-backend \
   jsonPayload.queue=\"dead-letters\"" \
  --project $PROJECT --limit 20 \
  --format "value(jsonPayload)"

# 2. Failure-Grund identifizieren
# → jsonPayload.error zeigt den Stack-Trace
# → Häufig: OPENAI_API_KEY abgelaufen, DB-Timeout, externe API down

# 3. Secret aktualisieren falls AI-Key abgelaufen
echo -n "sk-NEUER_KEY" | gcloud secrets versions add OPENAI_API_KEY \
  --data-file=- --project=$PROJECT

# 4. Service neu deployen damit neues Secret gezogen wird
gcloud run deploy realsync-backend \
  --image $(gcloud run services describe realsync-backend \
    --region $REGION --project $PROJECT \
    --format "value(spec.template.spec.containers[0].image)") \
  --region $REGION --project $PROJECT
```

---

## Rollback-Prozedur

### Automatischer Rollback (empfohlen)

```bash
# Letzten 5 Revisionen anzeigen
gcloud run revisions list \
  --service realsync-backend \
  --region $REGION --project $PROJECT \
  --sort-by "~createTime" --limit 5

# Traffic auf stabile Revision umleiten (kein Neustart nötig)
gcloud run services update-traffic realsync-backend \
  --region $REGION --project $PROJECT \
  --to-revisions REVISION_NAME=100

# Bestätigen
curl -sf $BACKEND/health | python3 -m json.tool
bash scripts/smoke_test.sh $BACKEND
```

### Rollback über GitHub Actions (empfohlen für DB-Migrationen)

```bash
# 1. In GitHub: Actions → Re-run workflow auf letztem stabilen Commit
# 2. ODER: Git revert + push
git revert HEAD --no-edit
git push origin main
# → Pipeline läuft automatisch, deploy.yml v4 übernimmt Migration + Deploy
```

---

## Secrets-Rotation

### Alle Secrets rotieren (z.B. nach Sicherheitsvorfall)

```bash
# Neue Kryptografie-Secrets generieren
NEW_JWT=$(openssl rand -hex 64)
NEW_REFRESH=$(openssl rand -hex 64)
NEW_AGENT=$(openssl rand -hex 32)
NEW_GATEWAY=$(openssl rand -hex 32)
NEW_HEALTH=$(openssl rand -hex 32)

# Secret Manager aktualisieren
for SECRET in JWT_SECRET JWT_REFRESH_SECRET AGENT_INTERNAL_KEY GATEWAY_SECRET INTERNAL_HEALTH_KEY; do
  VAR="NEW_$(echo $SECRET | sed 's/_SECRET//' | sed 's/_KEY//' | sed 's/_//')"
  # Vereinfacht — in Praxis einzeln:
  echo "Aktualisiere $SECRET..."
done

echo -n "$NEW_JWT"     | gcloud secrets versions add JWT_SECRET     --data-file=- --project=$PROJECT
echo -n "$NEW_REFRESH" | gcloud secrets versions add JWT_REFRESH_SECRET --data-file=- --project=$PROJECT
echo -n "$NEW_AGENT"   | gcloud secrets versions add AGENT_INTERNAL_KEY --data-file=- --project=$PROJECT
echo -n "$NEW_GATEWAY" | gcloud secrets versions add GATEWAY_SECRET  --data-file=- --project=$PROJECT
echo -n "$NEW_HEALTH"  | gcloud secrets versions add INTERNAL_HEALTH_KEY --data-file=- --project=$PROJECT

# Service neu deployen (zieht neue Secret-Versionen)
gcloud run deploy realsync-backend \
  --image $(gcloud run services describe realsync-backend \
    --region $REGION --project $PROJECT \
    --format "value(spec.template.spec.containers[0].image)") \
  --region $REGION --project $PROJECT

# WICHTIG: Alle aktiven JWT-Sessions sind nach Rotation ungültig.
# → Nutzer müssen sich neu einloggen.
# → Für Zero-Downtime-Rotation: alten Secret 15 Minuten parallel halten.
```

### Einzelnes Secret rotieren (z.B. OPENAI_API_KEY)

```bash
echo -n "sk-NEUER_WERT" | gcloud secrets versions add OPENAI_API_KEY \
  --data-file=- --project=$PROJECT

# Neues Secret sofort aktiv machen (Service neu deployen)
gcloud run deploy realsync-backend \
  --image $(gcloud run services describe realsync-backend \
    --region $REGION --project $PROJECT \
    --format "value(spec.template.spec.containers[0].image)") \
  --region $REGION --project $PROJECT \
  --no-traffic  # erst testen, dann Traffic umleiten

# Testen
NEW_REVISION=$(gcloud run revisions list \
  --service realsync-backend \
  --region $REGION --project $PROJECT \
  --sort-by "~createTime" --limit 1 --format "value(name)")

gcloud run services update-traffic realsync-backend \
  --region $REGION --project $PROJECT \
  --to-revisions $NEW_REVISION=10  # erst 10% Traffic

# Bestätigen, dann auf 100%
gcloud run services update-traffic realsync-backend \
  --region $REGION --project $PROJECT \
  --to-latest
```

---

## Monitoring überprüfen

```bash
# Alle Alert-Policies anzeigen
gcloud alpha monitoring policies list \
  --project=$PROJECT \
  --format="table(displayName,enabled,conditions[0].conditionThreshold.thresholdValue)"

# Alert-Policy aktivieren/deaktivieren
gcloud alpha monitoring policies update POLICY_NAME \
  --project=$PROJECT --enabled   # oder --no-enabled

# Monitoring-Script erneut ausführen (falls Alerts fehlen)
export ALERT_EMAIL="ops@realsyncdynamics.com"
bash scripts/setup_monitoring.sh
```

---

## Kapazitätsplanung

### Max-Instanzen erhöhen

```bash
# Backend: aktuell max 10
gcloud run services update realsync-backend \
  --region $REGION --project $PROJECT \
  --max-instances 20

# Gateway: aktuell max 5
gcloud run services update realsync-gateway \
  --region $REGION --project $PROJECT \
  --max-instances 10
```

### Concurrency anpassen

```bash
# Aktuell: 80 gleichzeitige Requests pro Instanz
# Bei AI-lastigen Workloads (OpenAI wartet): auf 20 senken
gcloud run services update realsync-backend \
  --region $REGION --project $PROJECT \
  --concurrency 20
```

---

## Wartungsfenster

### Geplante Wartung ankündigen

```bash
# Cloud Run: Rolling deploy ohne Downtime (kein Wartungsfenster nötig bei min-instances ≥ 1)
# Bei DB-Migrationen: deploy.yml führt Migration VOR dem Deploy aus → 0 Downtime

# Notfall-Maintenance-Mode (503 für alle Requests):
# 1. Backend auf "maintenance"-Image deployen (statische 503-Seite)
# 2. ODER: Cloud Run auf 0 Instanzen setzen (kalt, 2s Cold-Start bei Wiederkehr)
gcloud run services update realsync-backend \
  --region $REGION --project $PROJECT \
  --min-instances 0 --max-instances 0  # VORSICHT: blockiert alle Requests
```

---

## EU AI Act — Pflicht-Checks

Nach jedem Deploy sicherstellen:

```bash
# 1. eu_ai_act_compliant Flag in /health
curl -sf $BACKEND/health | python3 -c \
  "import json,sys; d=json.load(sys.stdin); \
   assert d.get('eu_ai_act_compliant') == True, 'EU AI ACT FLAG FEHLT!'; \
   print('EU AI Act: OK')"

# 2. Audit-Log schreibt (Test-Eintrag)
# → POST /api/v1/workflows mit gültigem JWT erstellt einen Audit-Log-Eintrag
# → prüfen via GET /api/v1/audit?limit=1

# 3. Human-Approval für Professional/Enterprise prüfen
# → POST /api/v1/approvals muss 201 zurückgeben (nicht 404)

# 4. RFC 9457 Error-Format (Art. 14 — Transparenz)
curl -sf $BACKEND/nonexistent 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); \
  assert 'type' in d, 'RFC 9457 type fehlt'; print('RFC 9457: OK')" || true
```

---

## Post-Mortem-Template

```markdown
## Incident Report — [DATUM] [P0/P1]

**Dauer:** HH:MM – HH:MM CEST
**Betroffene Dienste:** Backend / Gateway / DB / ...
**Auswirkung:** X% der Requests fehlgeschlagen, Y Tenants betroffen

### Zeitlinie
- HH:MM — Alert ausgelöst
- HH:MM — Ursache identifiziert: ...
- HH:MM — Maßnahme eingeleitet: ...
- HH:MM — Service wiederhergestellt
- HH:MM — Bestätigt via smoke_test.sh

### Ursache (Root Cause)
...

### Maßnahme
...

### Präventionsmaßnahmen
- [ ] ...
- [ ] ...
```
