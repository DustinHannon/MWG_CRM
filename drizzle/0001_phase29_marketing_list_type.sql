-- Phase 29 §5 (Sub-agent B) — dynamic + static list types and mass-edit infra.
--
-- Adds:
--   • Two new enums: marketing_list_type, marketing_list_source_entity.
--   • Two columns on marketing_lists: list_type, source_entity.
--   • New table marketing_static_list_members + indexes.
--   • Two permission columns on users: can_marketing_lists_import,
--     can_marketing_migrations_run (the latter is owned by Sub-agent D
--     but added here in the same migration for atomicity).
--
-- All changes are reversible (rollback at the bottom commented out).
-- Per Phase 27 CLAUDE.md, reversible migrations ship without sign-off.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE marketing_list_type AS ENUM ('dynamic', 'static_imported');

CREATE TYPE marketing_list_source_entity AS ENUM (
  'leads',
  'contacts',
  'accounts',
  'opportunities',
  'mixed'
);

-- -----------------------------------------------------------------------------
-- marketing_lists: add list_type + source_entity
-- -----------------------------------------------------------------------------

ALTER TABLE marketing_lists
  ADD COLUMN list_type marketing_list_type NOT NULL DEFAULT 'dynamic';

ALTER TABLE marketing_lists
  ADD COLUMN source_entity marketing_list_source_entity DEFAULT 'leads';

-- Backfill is implicit via the DEFAULT clauses — existing rows now read
-- 'dynamic' / 'leads' which matches Phase 19 behavior.

-- -----------------------------------------------------------------------------
-- marketing_static_list_members
-- -----------------------------------------------------------------------------

CREATE TABLE marketing_static_list_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES marketing_lists(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive dedup per list.
CREATE UNIQUE INDEX mkt_static_lm_list_email_uniq
  ON marketing_static_list_members (list_id, lower(email));

CREATE INDEX mkt_static_lm_list_idx
  ON marketing_static_list_members (list_id);

CREATE INDEX mkt_static_lm_email_idx
  ON marketing_static_list_members (lower(email));

-- -----------------------------------------------------------------------------
-- Permission columns
-- -----------------------------------------------------------------------------

ALTER TABLE permissions
  ADD COLUMN can_marketing_lists_import boolean NOT NULL DEFAULT false;

ALTER TABLE permissions
  ADD COLUMN can_marketing_migrations_run boolean NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------------
-- Rollback (manual, not auto-run)
-- -----------------------------------------------------------------------------
-- ALTER TABLE permissions DROP COLUMN can_marketing_migrations_run;
-- ALTER TABLE permissions DROP COLUMN can_marketing_lists_import;
-- DROP TABLE marketing_static_list_members;
-- ALTER TABLE marketing_lists DROP COLUMN source_entity;
-- ALTER TABLE marketing_lists DROP COLUMN list_type;
-- DROP TYPE marketing_list_source_entity;
-- DROP TYPE marketing_list_type;
