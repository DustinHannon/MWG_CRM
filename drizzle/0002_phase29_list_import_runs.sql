-- Phase 29 §6 (Sub-agent C) — Static-list Excel import worklog.
--
-- Adds:
--   • New enum: list_import_run_status.
--   • New table: list_import_runs (mirrors import_jobs but FK'd to
--     marketing_lists and carrying a parsed_rows JSONB so commit does
--     not re-parse the workbook).
--
-- All changes are reversible. Per Phase 27 CLAUDE.md, reversible
-- migrations ship without sign-off.

-- -----------------------------------------------------------------------------
-- Enum
-- -----------------------------------------------------------------------------

CREATE TYPE list_import_run_status AS ENUM (
  'pending',
  'previewing',
  'committing',
  'success',
  'partial_failure',
  'cancelled'
);

-- -----------------------------------------------------------------------------
-- list_import_runs
-- -----------------------------------------------------------------------------

CREATE TABLE list_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES marketing_lists(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  filename text NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  successful_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  needs_review_rows integer NOT NULL DEFAULT 0,
  errors jsonb,
  parsed_rows jsonb,
  status list_import_run_status NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX list_import_runs_list_user_idx
  ON list_import_runs (list_id, user_id);

CREATE INDEX list_import_runs_status_idx
  ON list_import_runs (status);

-- Covering index for the user_id FK (avoids the
-- `unindexed_foreign_keys` Supabase advisory).
CREATE INDEX list_import_runs_user_id_idx
  ON list_import_runs (user_id);

-- -----------------------------------------------------------------------------
-- RLS — defense-in-depth (see mwg_crm_architecture.md). Every public.*
-- table in this project enables RLS without policies; the app role has
-- BYPASSRLS so traffic is unaffected.
-- -----------------------------------------------------------------------------

ALTER TABLE list_import_runs ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Rollback (manual, not auto-run)
-- -----------------------------------------------------------------------------
-- DROP TABLE list_import_runs;
-- DROP TYPE list_import_run_status;
