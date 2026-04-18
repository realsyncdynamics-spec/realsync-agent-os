-- ============================================================
-- Migration 001 — Auth Tables & Scheduled Posts
-- RealSyncDynamics Agent-OS
-- PostgreSQL 16 | pgcrypto required
-- ============================================================

-- ─── refresh_tokens ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,   -- SHA-256 hex of the raw token
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  user_agent    TEXT,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  refresh_tokens                IS 'Issued JWT refresh tokens — raw token is never stored, only SHA-256 hash';
COMMENT ON COLUMN refresh_tokens.token_hash     IS 'SHA-256(raw_refresh_token) stored as hex — allows O(1) lookup without exposing token';
COMMENT ON COLUMN refresh_tokens.revoked        IS 'True = token has been invalidated (logout or rotation)';

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
  ON refresh_tokens(user_id)
  WHERE revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
  ON refresh_tokens(expires_at)
  WHERE revoked = FALSE;

-- ─── password_reset_tokens ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,   -- SHA-256 hex of the one-time token
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN     NOT NULL DEFAULT FALSE,
  used_at       TIMESTAMPTZ,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  password_reset_tokens            IS 'Single-use password reset tokens — valid for 1 hour, invalidated after use';
COMMENT ON COLUMN password_reset_tokens.token_hash IS 'SHA-256(raw_token) stored as hex — raw token sent via email, never stored';
COMMENT ON COLUMN password_reset_tokens.used       IS 'True = token has been consumed — cannot be reused';

CREATE INDEX IF NOT EXISTS idx_prt_user_id
  ON password_reset_tokens(user_id)
  WHERE used = FALSE;

-- ─── scheduled_posts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT        NOT NULL CHECK (platform IN ('linkedin', 'twitter', 'facebook', 'instagram')),
  content         TEXT        NOT NULL,
  media_urls      TEXT[]      NOT NULL DEFAULT '{}',
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'published', 'failed', 'cancelled')),
  external_post_id TEXT,                       -- Platform-returned post ID after publish
  failure_reason  TEXT,
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  max_retries     INTEGER     NOT NULL DEFAULT 3,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  scheduled_posts                  IS 'Social media posts queued for future publication via marketing-agent';
COMMENT ON COLUMN scheduled_posts.external_post_id IS 'Post ID returned by the social platform after successful publish';
COMMENT ON COLUMN scheduled_posts.retry_count      IS 'Number of publish attempts made — capped at max_retries before marking failed';

-- Partial index: only pending posts are queried by the scheduler — keeps this index tiny
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending
  ON scheduled_posts(scheduled_for)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_tenant_id
  ON scheduled_posts(tenant_id, status);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER scheduled_posts_updated_at
    BEFORE UPDATE ON scheduled_posts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── audit_logs table (if not exists from Sprint 1) ──────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        REFERENCES tenants(id) ON DELETE SET NULL,
  user_id     UUID        REFERENCES users(id)   ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  details     JSONB       NOT NULL DEFAULT '{}',
  ip_address  INET,
  user_agent  TEXT,
  status      TEXT        NOT NULL DEFAULT 'success'
              CHECK (status IN ('success', 'error', 'blocked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE audit_logs IS 'Immutable audit trail — EU AI Act Art. 12 compliance. Never delete rows; set a retention policy instead.';

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id  ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id    ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs(action, created_at DESC);
