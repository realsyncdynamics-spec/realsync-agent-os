-- ============================================================
-- Migration 002 — Human Approval Workflow Table
-- RealSyncDynamics Agent-OS
-- EU AI Act Art. 14 — Human Oversight
-- PostgreSQL 16 | pgcrypto required
-- ============================================================

CREATE TABLE IF NOT EXISTS approvals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id      UUID        REFERENCES workflows(id) ON DELETE SET NULL,
  task_id          UUID        REFERENCES tasks(id)     ON DELETE SET NULL,

  -- Who requested the approval and for what
  requested_by     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action           TEXT        NOT NULL,                       -- e.g. 'post_to_linkedin', 'delete_data'
  context          JSONB       NOT NULL DEFAULT '{}',          -- payload for the approver to review
  risk_level       TEXT        NOT NULL DEFAULT 'medium'
                               CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  description      TEXT,                                       -- human-readable explanation

  -- Assignment (nullable = unassigned, any tenant admin can approve)
  assigned_to      UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- Status lifecycle: pending → approved | rejected | expired
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

  -- Decision
  decision_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  decision_at      TIMESTAMPTZ,
  decision_comment TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  approvals              IS 'Human-in-the-loop approval requests — EU AI Act Art. 14 compliance';
COMMENT ON COLUMN approvals.action       IS 'The agent action awaiting human approval, e.g. post_to_linkedin';
COMMENT ON COLUMN approvals.context      IS 'Full payload shown to the approver — must contain enough info to make an informed decision';
COMMENT ON COLUMN approvals.risk_level   IS 'Determines urgency and who can approve: low=any member, high/critical=admin only';
COMMENT ON COLUMN approvals.expires_at   IS 'Auto-reject if not decided by this time (24h default, configurable per risk level)';

-- Partial index: scheduler queries only pending+not-expired rows
CREATE INDEX IF NOT EXISTS idx_approvals_pending
  ON approvals(tenant_id, expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_approvals_workflow
  ON approvals(workflow_id, status);

CREATE INDEX IF NOT EXISTS idx_approvals_requested_by
  ON approvals(requested_by, created_at DESC);

-- Auto-update updated_at
DO $$ BEGIN
  CREATE TRIGGER approvals_updated_at
    BEFORE UPDATE ON approvals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Auto-expire job (run via pg_cron or scheduled BullMQ job) ───────────────
-- Example query to expire stale approvals (run every 5 minutes):
--
--   UPDATE approvals
--   SET status = 'expired', updated_at = NOW()
--   WHERE status = 'pending' AND expires_at < NOW();
--
-- Each expiry should also update the associated task:
--   UPDATE tasks SET status = 'failed', error = 'Approval expired'
--   WHERE id IN (SELECT task_id FROM approvals WHERE status = 'expired' AND task_id IS NOT NULL);
