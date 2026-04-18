-- RealSyncDynamics Agent-OS Database Schema
-- Version 1.0.0 | EU-AI-Act konform (Art. 12 Logging)
-- Führe aus: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- für gen_random_uuid()

-- ─── ENUM-Typen ───────────────────────────────────────────────────────────────
-- Zuerst alle benutzerdefinierten ENUM-Typen anlegen

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'member');

CREATE TYPE tenant_plan AS ENUM ('free', 'starter', 'professional', 'enterprise');

CREATE TYPE workflow_status AS ENUM ('draft', 'active', 'paused', 'completed', 'error');

CREATE TYPE agent_type AS ENUM ('manager', 'devops', 'marketing', 'compliance', 'research');

CREATE TYPE task_status AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TYPE gateway_status AS ENUM ('online', 'offline', 'error');

CREATE TYPE risk_level AS ENUM ('minimal', 'limited', 'high');

-- ─── Tabelle: tenants ─────────────────────────────────────────────────────────

CREATE TABLE tenants (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(255)    NOT NULL,
    slug                VARCHAR(100)    NOT NULL UNIQUE,           -- URL-sicherer Bezeichner, z.B. "acme-gmbh"
    plan                tenant_plan     NOT NULL DEFAULT 'free',
    stripe_customer_id  VARCHAR(255)    UNIQUE,                    -- Stripe Customer-ID (cus_...)
    stripe_subscription_id VARCHAR(255) UNIQUE,                    -- Stripe Subscription-ID (sub_...)
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    settings            JSONB           NOT NULL DEFAULT '{}',     -- Tenant-spezifische Einstellungen (Limits, Feature-Flags, etc.)
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Indizes
CREATE INDEX idx_tenants_stripe_customer_id ON tenants (stripe_customer_id);
CREATE INDEX idx_tenants_plan ON tenants (plan);
CREATE INDEX idx_tenants_is_active ON tenants (is_active);

-- Beispiel für settings JSONB-Struktur:
-- {
--   "max_workflows": 10,
--   "max_agents": 5,
--   "allowed_agent_types": ["devops", "marketing"],
--   "eu_ai_act_tier": "limited",
--   "data_residency": "eu-west-1",
--   "feature_flags": { "openclaw_enabled": true, "compliance_reports": true }
-- }

-- ─── Tabelle: users ───────────────────────────────────────────────────────────

CREATE TABLE users (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           VARCHAR(320)    NOT NULL,
    password_hash   VARCHAR(255),                                  -- NULL wenn OAuth-only
    role            user_role       NOT NULL DEFAULT 'member',
    display_name    VARCHAR(255),
    avatar_url      TEXT,
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    mfa_enabled     BOOLEAN         NOT NULL DEFAULT FALSE,
    mfa_secret      VARCHAR(255),                                  -- TOTP-Secret (verschlüsselt)
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_users_tenant_email UNIQUE (tenant_id, email)
);

-- Indizes
CREATE INDEX idx_users_tenant_id ON users (tenant_id);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role ON users (tenant_id, role);

-- Row Level Security für Multi-Tenancy
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_tenant_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ─── Tabelle: workflows ───────────────────────────────────────────────────────

CREATE TABLE workflows (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_by      UUID                REFERENCES users(id) ON DELETE SET NULL,
    title           VARCHAR(500)        NOT NULL,
    goal            TEXT                NOT NULL,                  -- Natürlichsprachliches Ziel des Workflows
    status          workflow_status     NOT NULL DEFAULT 'draft',
    config          JSONB               NOT NULL DEFAULT '{}',     -- Vollständiges Workflow-JSON-Schema
    version         INT                 NOT NULL DEFAULT 1,        -- Optimistic locking / Versionierung
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,                                   -- Für cron-basierte Trigger
    run_count       INT                 NOT NULL DEFAULT 0,
    error_count     INT                 NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- Indizes
CREATE INDEX idx_workflows_tenant_id ON workflows (tenant_id);
CREATE INDEX idx_workflows_status ON workflows (tenant_id, status);
CREATE INDEX idx_workflows_next_run_at ON workflows (next_run_at) WHERE status = 'active';
CREATE INDEX idx_workflows_config_gin ON workflows USING GIN (config);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflows_tenant_isolation ON workflows
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ─── Tabelle: tasks ───────────────────────────────────────────────────────────

CREATE TABLE tasks (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID            NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    agent_type      agent_type      NOT NULL,
    title           VARCHAR(500)    NOT NULL,
    payload         JSONB           NOT NULL DEFAULT '{}',         -- Input-Daten und Anweisungen für den Agenten
    status          task_status     NOT NULL DEFAULT 'pending',
    priority        INT             NOT NULL DEFAULT 5             -- 1 (höchste) bis 10 (niedrigste)
                    CHECK (priority BETWEEN 1 AND 10),
    depends_on      UUID[]          NOT NULL DEFAULT '{}',         -- Array von Task-IDs, die zuerst abgeschlossen sein müssen
    retry_count     INT             NOT NULL DEFAULT 0,
    max_retries     INT             NOT NULL DEFAULT 3,
    error           TEXT,                                          -- Letzte Fehlermeldung bei status = 'failed'
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,

    CONSTRAINT chk_tasks_timing CHECK (
        started_at IS NULL OR started_at >= created_at
    )
);

-- Indizes
CREATE INDEX idx_tasks_workflow_id ON tasks (workflow_id);
CREATE INDEX idx_tasks_status ON tasks (status, priority);
CREATE INDEX idx_tasks_agent_type ON tasks (agent_type, status);
CREATE INDEX idx_tasks_depends_on ON tasks USING GIN (depends_on);
CREATE INDEX idx_tasks_created_at ON tasks (created_at DESC);

-- ─── Tabelle: agent_runs ─────────────────────────────────────────────────────

CREATE TABLE agent_runs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    model_used      TEXT        NOT NULL,                          -- z.B. "gpt-4o", "claude-3-5-sonnet-20241022"
    input           JSONB       NOT NULL DEFAULT '{}',             -- Prompt / Nachrichten-Array
    output          JSONB       NOT NULL DEFAULT '{}',             -- Modell-Antwort inkl. tool_calls
    tokens_used     INT         NOT NULL DEFAULT 0
                    CHECK (tokens_used >= 0),
    tokens_input    INT         NOT NULL DEFAULT 0,                -- Aufschlüsselung Input-Tokens
    tokens_output   INT         NOT NULL DEFAULT 0,                -- Aufschlüsselung Output-Tokens
    duration_ms     INT         NOT NULL DEFAULT 0
                    CHECK (duration_ms >= 0),
    cost_usd        NUMERIC(10,6),                                 -- Geschätzte Kosten in USD
    success         BOOLEAN     NOT NULL DEFAULT TRUE,
    error_code      VARCHAR(100),                                  -- z.B. "RATE_LIMIT", "CONTEXT_LENGTH_EXCEEDED"
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indizes
CREATE INDEX idx_agent_runs_task_id ON agent_runs (task_id);
CREATE INDEX idx_agent_runs_model_used ON agent_runs (model_used);
CREATE INDEX idx_agent_runs_created_at ON agent_runs (created_at DESC);

-- ─── Tabelle: openclaw_gateways ──────────────────────────────────────────────

CREATE TABLE openclaw_gateways (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                VARCHAR(255)    NOT NULL,
    host                TEXT            NOT NULL,                  -- Hostname/IP des OpenClaw-Gateways
    port                INT             NOT NULL DEFAULT 3000,
    api_key_hash        VARCHAR(255)    NOT NULL,                  -- bcrypt/argon2-Hash des API-Keys
    tls_fingerprint     VARCHAR(255),                              -- SHA-256 TLS-Zertifikats-Fingerprint
    status              gateway_status  NOT NULL DEFAULT 'offline',
    last_heartbeat      TIMESTAMPTZ,
    capabilities        JSONB           NOT NULL DEFAULT '{}',     -- Verfügbare Aktionen/Integrationen
    version             VARCHAR(50),                               -- OpenClaw-Gateway-Version
    tags                TEXT[]          NOT NULL DEFAULT '{}',     -- z.B. ["production", "eu-west"]
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_gateways_tenant_host UNIQUE (tenant_id, host)
);

-- Indizes
CREATE INDEX idx_gateways_tenant_id ON openclaw_gateways (tenant_id);
CREATE INDEX idx_gateways_status ON openclaw_gateways (status);
CREATE INDEX idx_gateways_last_heartbeat ON openclaw_gateways (last_heartbeat);
CREATE INDEX idx_gateways_capabilities_gin ON openclaw_gateways USING GIN (capabilities);

-- Beispiel für capabilities JSONB:
-- {
--   "ssh": true,
--   "docker": true,
--   "kubernetes": false,
--   "email_smtp": true,
--   "file_system": true,
--   "http_client": true,
--   "os": "linux",
--   "arch": "amd64",
--   "max_concurrent_jobs": 5
-- }

-- ─── Tabelle: audit_logs ─────────────────────────────────────────────────────

CREATE TABLE audit_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL, -- NULL bei System-Aktionen
    action          TEXT        NOT NULL,                          -- z.B. "workflow.create", "task.execute", "user.role_changed"
    entity_type     TEXT        NOT NULL,                          -- z.B. "workflow", "task", "user", "gateway"
    entity_id       UUID,                                          -- ID der betroffenen Entität
    before          JSONB,                                         -- Zustand vor der Änderung (für UPDATE/DELETE)
    after           JSONB,                                         -- Zustand nach der Änderung (für CREATE/UPDATE)
    ip              TEXT,                                          -- IPv4/IPv6 des Initiators
    user_agent      TEXT,                                          -- Browser/Client-UA für forensische Analyse
    session_id      VARCHAR(255),                                  -- Session-Referenz
    risk_score      SMALLINT    DEFAULT 0                          -- 0-100: automatisch berechnet (Anomalie-Erkennung)
                    CHECK (risk_score BETWEEN 0 AND 100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit-Logs sind unveränderlich (kein UPDATE/DELETE durch Applikation)
-- EU AI Act Art. 12 – Aufzeichnungspflicht für Hochrisiko-KI-Systeme
CREATE INDEX idx_audit_logs_tenant_id ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_user_id ON audit_logs (user_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action, created_at DESC);
CREATE INDEX idx_audit_logs_risk_score ON audit_logs (risk_score DESC) WHERE risk_score > 50;

-- Partitionierung nach Monat (Empfehlung für Produktionsbetrieb)
-- ALTER TABLE audit_logs PARTITION BY RANGE (created_at);

-- ─── Tabelle: compliance_reports ─────────────────────────────────────────────

CREATE TABLE compliance_reports (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workflow_id     UUID        REFERENCES workflows(id) ON DELETE SET NULL,
    report_type     VARCHAR(100) NOT NULL DEFAULT 'eu_ai_act',    -- z.B. "eu_ai_act", "dsgvo", "custom"
    risk_level      risk_level  NOT NULL,
    findings        JSONB       NOT NULL DEFAULT '{}',             -- Strukturierte Befunde
    recommendations JSONB       NOT NULL DEFAULT '[]',             -- Liste von Handlungsempfehlungen
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by    agent_type  NOT NULL DEFAULT 'compliance',    -- Welcher Agent generiert hat
    approved_by     UUID        REFERENCES users(id) ON DELETE SET NULL, -- NULL = noch nicht genehmigt
    approved_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                                   -- Ablaufdatum (z.B. +12 Monate)
    version         INT         NOT NULL DEFAULT 1,

    CONSTRAINT chk_approval_consistency CHECK (
        (approved_by IS NULL AND approved_at IS NULL) OR
        (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

-- Indizes
CREATE INDEX idx_compliance_tenant_id ON compliance_reports (tenant_id, generated_at DESC);
CREATE INDEX idx_compliance_workflow_id ON compliance_reports (workflow_id);
CREATE INDEX idx_compliance_risk_level ON compliance_reports (risk_level, tenant_id);
CREATE INDEX idx_compliance_approved_by ON compliance_reports (approved_by);
CREATE INDEX idx_compliance_findings_gin ON compliance_reports USING GIN (findings);
