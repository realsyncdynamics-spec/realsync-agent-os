# RealSync Agent-OS — MVP Scope & Zielgruppe

**Stand:** April 2026 | **Status:** Eingefroren für v1.0

> Nicht noch mehr denken — deployen, eingrenzen, protokollieren.

---

## Zielgruppe (eine, nicht mehrere)

**Kleine und mittelständische Unternehmen in Deutschland**
- Betriebsgröße: 5–50 Mitarbeiter
- Branchen: Dienstleistung, Handel, Beratung, Handwerk
- Schmerz: Wiederkehrende manuelle Prozesse fressen Zeit, aber keine IT-Abteilung vorhanden
- Budget: €29–99/Monat (Starter/Professional Plan)
- Entscheider: Geschäftsführer oder Office Manager, kein CTO

**Nicht** (bewusster Ausschluss für v1.0):
- ❌ Schulen und Behörden (anderer Beschaffungsprozess, längere Sales-Zyklen)
- ❌ Konzerne (Enterprise-Compliance-Anforderungen sprengen MVP-Scope)
- ❌ Internationaler Markt (erst nach stabilem DACH-Rollout)

---

## Die drei einzufrierende Playbooks

Genau diese drei — kein viertes vor dem ersten Live-Kunden.

### 1. Daily Health Check (`daily_health_check`)
- **Was:** Täglicher System-Check um 06:00 UTC, KI-Diagnose bei Anomalien, E-Mail + Slack
- **Wert:** "Ich weiß jeden Morgen, dass meine Systeme laufen — ohne selbst nachzuschauen"
- **EU AI Act:** Minimal Risk — kein Approval Gate nötig
- **Status:** ✅ Im Repo (`playbooks/daily_health_check.json`)

### 2. Backup Verification (`backup_verify`)
- **Was:** Tägliche Prüfung ob Backups vorhanden und nicht korrupt, Alert bei Fehlschlag
- **Wert:** "Mein Backup funktioniert wirklich — ich bemerke es, bevor ich es brauche"
- **EU AI Act:** Minimal Risk
- **Status:** ✅ Im Repo (`scripts/backup_verify.sh` + `playbooks/` kommt Sprint 6)

### 3. Invoice-to-Archive (`invoice_to_archive`)
- **Was:** Eingangsrechnungen per E-Mail empfangen → KI extrahiert Daten → Freigabe ab €1.000 → Google Drive + S3 + Buchhaltungseintrag
- **Wert:** "Rechnungen kommen rein und landen automatisch im Archiv — fertig für den Steuerberater"
- **EU AI Act:** Limited Risk — Art. 50 Transparenzpflicht, AI-Label in Metadaten, Human Approval Gate
- **Status:** ✅ Im Repo (`playbooks/invoice_to_archive.json`)

---

## Enger Feature-Scope v1.0

### Drin (muss funktionieren)
- [ ] 3 Playbooks laufen stabil durch (End-to-End, nicht nur Demo)
- [ ] Auth: Register, Login, Refresh — JWT funktioniert
- [ ] Human Approval: Freigabe per Web-UI (Flutter) und E-Mail-Link
- [ ] Audit Log: Jede Aktion protokolliert, Export für Steuerberater
- [ ] Stripe: Free Trial → Starter €29 Upgrade-Flow
- [ ] Cloud Run: Backend + Gateway live in europe-west1
- [ ] Health-Monitoring: `/health/ready` liefert DB + Redis Status

### Nicht drin v1.0 (Backlog)
- ❌ Mobile App (Flutter Pages sind als Web-App ausreichend)
- ❌ Marketing-Agent (Social Media zu viel Scope für KMU-MVP)
- ❌ Research-Agent (kein klarer KMU-Use-Case im Erstzugang)
- ❌ Multi-Gateway (ein Gateway reicht für Pilot-Kunden)
- ❌ Schulen / Behörden Compliance-Tier
- ❌ Internationalisierung (EN, FR)

---

## Definition of Done — v1.0 ist fertig wenn

1. **Infrastruktur bewiesen:** `/health` antwortet mit `200 ok` auf Cloud Run
2. **Playbook läuft:** `daily_health_check` wird täglich ausgeführt, Ergebnis in DB
3. **Approval funktioniert:** Invoice über €1.000 wartet auf Freigabe, Entscheidung landet im Audit Log
4. **Erster externer Benutzer:** Ein echter Pilot-Kunde hat sich registriert und einen Workflow ausgeführt
5. **Audit-Export:** Steuerberater kann CSV-Export der archivierten Rechnungen herunterladen

---

## Wachstumspfad nach v1.0

Erst wenn alle 5 DoD-Punkte erfüllt sind:

```
v1.0 — KMU DE (3 Playbooks, 1 Gateway, Starter/Pro)
  ↓
v1.1 — Backup-Playbook vollständig + Log-Anomaly-Alert
  ↓
v1.2 — Zweiter Vertical: Schulen (anderer Compliance-Tier, FERPA-ähnlich)
  ↓
v2.0 — Marketing-Agent für KMU (Social Media Automation)
  ↓
v2.1 — Research-Agent (Wettbewerbsanalyse für Beratungsfirmen)
```

---

## Preislogik (eingefroren)

| Plan | Preis | Playbooks | Gateways | Approvals/Monat |
|---|---|---|---|---|
| Free | €0 | 1 | 1 | 10 |
| Starter | €29 | 3 | 1 | 100 |
| Professional | €99 | unbegrenzt | 3 | unbegrenzt |
| Enterprise | individuell | unbegrenzt | unbegrenzt | unbegrenzt |

---

## EU AI Act Positionierung

Nicht als Pflichtlast behandeln — als Differenzierungsmerkmal kommunizieren:

> "RealSync ist die erste KI-Automatisierungsplattform für KMU, die von Anfang an EU AI Act-konform gebaut wurde. Jede KI-Entscheidung ist nachvollziehbar, jede Aktion protokolliert, jede riskante Operation benötigt menschliche Freigabe."

**Konkret sichtbar für Kunden:**
- Jeder Workflow zeigt `eu_risk_level` in der UI
- Audit-Export als One-Click für Steuerberater / Wirtschaftsprüfer
- Human-Approval-Badge in der Rechnung-Ansicht: "Freigegeben von [Name] am [Datum]"
- Datenschutzerklärung: Alle Daten in `europe-west1` (Frankfurt-Region)
