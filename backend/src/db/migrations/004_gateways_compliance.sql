-- ============================================================
-- Migration 004: OpenClaw Gateways + Compliance Reports
-- Sprint 15 — Production Hardening
--
-- Rechtsgrundlage: EU AI Act (RL 2024/1689), Art. 12, 17
-- Neue Tabellen:   openclaw_gateways, compliance_reports
-- Neue ENUMs:      gateway_status, risk_level
--
-- Sicher bei mehrfacher Ausführung (IF NOT EXISTS / DO $$)
-- ============================================================

-- ─── Enum: gateway_status ────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gateway_status') THEN
    CREATE TYPE gateway_status AS ENUM ('online', 'offline', 'error');
  END IF;
END $$;

-- ─── Enum: risk_level (EU AI Act Art. 6–9) ───────────────────────────────────
-- Klassifizierung: minimal = kein Risiko, limited = begrenzt, high = hoch
-- NICHT verwenden: low/medium/critical (Approvals-Schema ist separat)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'risk_level') THEN
    CREATE TYPE risk_level AS ENUM ('minimal', 'limited', 'high');
  END IF;
END $$;

-- ─── Tabelle: openclaw_gateways ──────────────────────────────────────────────
-- OpenClaw ist die "Hände" des Agent-OS — Execution Layer für KMU-Systeme.
-- Jeder Gateway repräsentiert einen laufenden OpenClaw-Prozess im KMU-Netz.

CREATE TABLE IF NOT EXISTS openclaw_gateways (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                VARCHAR(255)    NOT NULL,
    host                TEXT            NOT NULL,
    port                INT             NOT NULL DEFAULT 3000,
    api_key_hash        VARCHAR(255)    NOT NULL,   -- SHA-256 des API-Keys (Prod: argon2)
    tls_fingerprint     VARCHAR(255),               -- SHA-256 TLS-Zertifikats-Fingerprint
    status              gateway_status  NOT NULL DEFAULT 'offline',
    last_heartbeat      TIMESTAMPTZ,
    capabilities        JSONB           NOT NULL DEFAULT '{}',
    version             VARCHAR(50),
    tags                TEXT[]          NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_gateways_tenant_host UNIQUE (tenant_id, host)
);

-- Indizes für openclaw_gateways
CREATE INDEX IF NOT EXISTS idx_gateways_tenant_id
    ON openclaw_gateways (tenant_id);

CREATE INDEX IF NOT EXISTS idx_gateways_status
    ON openclaw_gateways (status);

CREATE INDEX IF NOT EXISTS idx_gateways_last_heartbeat
    ON openclaw_gateways (last_heartbeat);

CREATE INDEX IF NOT EXISTS idx_gateways_capabilities_gin
    ON openclaw_gateways USING GIN (capabilities);

-- ─── Tabelle: compliance_reports ─────────────────────────────────────────────
-- EU AI Act Art. 12: Aufzeichnungspflicht für Hochrisiko-KI-Systeme
-- EU AI Act Art. 17: Qualitätsmanagementsystem für Anbieter

CREATE TABLE IF NOT EXISTS compliance_reports (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workflow_id     UUID            REFERENCES workflows(id) ON DELETE SET NULL,
    report_type     VARCHAR(100)    NOT NULL DEFAULT 'eu_ai_act',
    risk_level      risk_level      NOT NULL,
    findings        JSONB           NOT NULL DEFAULT '{}',
    recommendations JSONB           NOT NULL DEFAULT '[]',
    generated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    generated_by    agent_type      NOT NULL DEFAULT 'compliance',
    approved_by     UUID            REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    version         INT             NOT NULL DEFAULT 1,

    CONSTRAINT chk_approval_consistency CHECK (
        (approved_by IS NULL AND approved_at IS NULL) OR
        (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

-- Indizes für compliance_reports
CREATE INDEX IF NOT EXISTS idx_compliance_tenant_id
    ON compliance_reports (tenant_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_workflow_id
    ON compliance_reports (workflow_id);

CREATE INDEX IF NOT EXISTS idx_compliance_risk_level
    ON compliance_reports (risk_level, tenant_id);

CREATE INDEX IF NOT EXISTS idx_compliance_approved_by
    ON compliance_reports (approved_by);

CREATE INDEX IF NOT EXISTS idx_compliance_findings_gin
    ON compliance_reports USING GIN (findings);

-- ─── Kommentare (Dokumentation im DB-Katalog) ─────────────────────────────────

COMMENT ON TABLE openclaw_gateways IS
  'OpenClaw Gateway-Registrierung — Execution Layer für KMU-Automatisierung. '
  'Jeder Eintrag repräsentiert einen laufenden OpenClaw-Prozess im Kundennetzwerk.';

COMMENT ON TABLE compliance_reports IS
  'EU-AI-Act-Compliance-Reports (RL 2024/1689). '
  'risk_level folgt Art. 6–9: minimal|limited|high. '
  'Jeder Report ist unveränderlich (nur approved_by/approved_at werden nachgetragen).';

COMMENT ON COLUMN compliance_reports.risk_level IS
  'EU AI Act Risikoklassifizierung: minimal (kein Risiko), limited (begrenzt), high (hoch). '
  'Nicht zu verwechseln mit approvals.risk_level (low|medium|high|critical).';

COMMENT ON COLUMN openclaw_gateways.api_key_hash IS
  'SHA-256-Hash des API-Keys. In Produktion: argon2id empfohlen.';
