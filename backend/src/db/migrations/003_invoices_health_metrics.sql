-- ============================================================
-- Migration 003 — Invoices + Health Metrics Tables
-- RealSyncDynamics Agent-OS
-- PostgreSQL 16 | pgcrypto required
-- Supports: invoice_to_archive + backup_verify + daily_health_check playbooks
-- ============================================================

-- ─── invoices ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Core invoice data (AI-extracted)
  invoice_number      TEXT        NOT NULL,
  invoice_date        DATE        NOT NULL,
  due_date            DATE,
  vendor_name         TEXT        NOT NULL,
  vendor_tax_id       TEXT,                          -- USt-IdNr.
  vendor_iban         TEXT,
  net_amount_eur      NUMERIC(12, 2) NOT NULL,
  tax_amount_eur      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  gross_amount_eur    NUMERIC(12, 2) NOT NULL,
  tax_rate_pct        NUMERIC(5, 2),
  currency            CHAR(3)     NOT NULL DEFAULT 'EUR',
  line_items          JSONB       NOT NULL DEFAULT '[]',
  payment_terms       TEXT,
  cost_center         TEXT,

  -- Archive locations
  archive_url_drive   TEXT,
  archive_url_s3      TEXT,

  -- EU AI Act Art. 50 — transparency
  ai_extracted        BOOLEAN     NOT NULL DEFAULT TRUE,
  ai_model            TEXT,
  ai_confidence       NUMERIC(4, 3),                -- 0.000 – 1.000

  -- Human approval
  approved_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  approved_at         TIMESTAMPTZ,
  approval_id         UUID        REFERENCES approvals(id) ON DELETE SET NULL,

  -- Workflow metadata
  status              TEXT        NOT NULL DEFAULT 'archived'
                                  CHECK (status IN ('pending', 'processing', 'archived', 'rejected', 'error')),
  processed_by_workflow TEXT      DEFAULT 'invoice_to_archive',
  workflow_run_id     UUID,

  -- DSGVO — Aufbewahrungspflicht § 147 AO: 10 Jahre
  retention_until     DATE        GENERATED ALWAYS AS (invoice_date + INTERVAL '10 years') STORED,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  invoices                    IS 'Eingangsrechnungen — verarbeitet via invoice_to_archive Playbook';
COMMENT ON COLUMN invoices.ai_extracted       IS 'True wenn Daten per KI extrahiert wurden (EU AI Act Art. 50)';
COMMENT ON COLUMN invoices.ai_confidence      IS 'Konfidenzwert der KI-Extraktion (0.0–1.0). Werte < 0.85 erfordern manuelle Prüfung.';
COMMENT ON COLUMN invoices.retention_until    IS 'Berechnetes Pflichtaufbewahrungsdatum nach § 147 AO (invoice_date + 10 Jahre)';

-- Unique constraint: no duplicate invoice per vendor per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_unique
  ON invoices(tenant_id, invoice_number, vendor_name);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_date
  ON invoices(tenant_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_vendor
  ON invoices(tenant_id, vendor_name);

CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON invoices(tenant_id, status)
  WHERE status != 'archived';

-- Auto-update updated_at
DO $$ BEGIN
  CREATE TRIGGER invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── health_metrics ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS health_metrics (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gateway_id        UUID        REFERENCES gateways(id) ON DELETE SET NULL,
  workflow_run_id   UUID,

  -- Metric identity
  metric_type       TEXT        NOT NULL
                                CHECK (metric_type IN (
                                  'system_health',    -- daily_health_check playbook
                                  'backup_verify',    -- backup_verify playbook
                                  'custom'
                                )),
  hostname          TEXT,
  status            TEXT        NOT NULL DEFAULT 'ok'
                                CHECK (status IN ('ok', 'warning', 'failed', 'unknown')),

  -- System metrics (system_health type)
  cpu_percent       NUMERIC(5, 2),
  ram_used_gb       NUMERIC(8, 2),
  ram_total_gb      NUMERIC(8, 2),
  disk_used_percent NUMERIC(5, 2),
  services_json     JSONB       DEFAULT '[]',   -- [{name, status, pid}]

  -- Generic details (all types)
  details           JSONB       NOT NULL DEFAULT '{}',

  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  health_metrics             IS 'Metriken von daily_health_check und backup_verify Playbooks';
COMMENT ON COLUMN health_metrics.metric_type IS 'system_health=daily_health_check, backup_verify=backup_verify_playbook';
COMMENT ON COLUMN health_metrics.details     IS 'Flexibles JSONB-Feld für playbook-spezifische Zusatzdaten';

CREATE INDEX IF NOT EXISTS idx_health_metrics_tenant_time
  ON health_metrics(tenant_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_metrics_type_status
  ON health_metrics(tenant_id, metric_type, status, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_metrics_gateway
  ON health_metrics(gateway_id, recorded_at DESC)
  WHERE gateway_id IS NOT NULL;

-- ─── invoice_exports (für Steuerberater-Download) ────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_exports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format        TEXT        NOT NULL DEFAULT 'csv'
                            CHECK (format IN ('csv', 'ndjson', 'pdf_zip')),
  date_from     DATE        NOT NULL,
  date_to       DATE        NOT NULL,
  row_count     INTEGER,
  file_url      TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'ready', 'expired', 'error')),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE invoice_exports IS 'Export-Requests für Steuerberater — generierte Dateien nach 7 Tagen gelöscht';

CREATE INDEX IF NOT EXISTS idx_invoice_exports_tenant
  ON invoice_exports(tenant_id, created_at DESC);
