-- Phase 32.5: drop the legacy canManageMarketing column.
--
-- Every call site that previously gated on `permissions.can_manage_marketing`
-- now reads a specific fine-grained `can_marketing_*` column. The column is
-- removed entirely with no compute helper, no derived getter, and no
-- @deprecated marker — Phase 32.5 explicitly overrides Phase 27's escalation
-- matrix for irreversible schema changes per the brief.

ALTER TABLE permissions DROP COLUMN can_manage_marketing;
