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

---

## Troubleshooting

### "google-github-actions/auth failed"
Falls der erste Run nach der Umstellung fehlschlägt:
1. Prüfe in GitHub Settings -> Secrets -> Actions, ob `WIF_PROVIDER` gesetzt ist.
2. Falls nicht, führe `bash scripts/bootstrap_deploy.sh` erneut aus oder setze ihn manuell (Format: `projects/NUM/locations/global/workloadIdentityPools/POOL/providers/PROVIDER`).

### "Permission denied on Artifact Registry"
Der Service Account braucht die Rolle `roles/artifactregistry.writer`. Das Bootstrap-Script setzt dies automatisch, erfordert aber `Owner` oder `Security Admin` Rechte beim Ausführenden.
