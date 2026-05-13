-- Phase 32.5 follow-up:
--   1. Drop the orphan canViewTeamRecords column — MWG has no team data
--      model, so the permission has nothing to gate.
--   2. Extend marketing_suppressions for manual add/remove tracking:
--      added_by_user_id captures who manually added/removed a row;
--      stays NULL for system-sourced rows (cron sync + webhook).
--      The suppression_type enum gains "manual" via TypeScript-only
--      narrowing (the DB column is plain text, no CHECK to update).

ALTER TABLE permissions DROP COLUMN can_view_team_records;

ALTER TABLE marketing_suppressions
  ADD COLUMN added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX mkt_sup_added_by_idx
  ON marketing_suppressions(added_by_user_id)
  WHERE added_by_user_id IS NOT NULL;
