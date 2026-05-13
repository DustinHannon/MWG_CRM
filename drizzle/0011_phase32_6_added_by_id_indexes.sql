-- Partial indexes on added_by_id covering the FK on each new junction
-- table. Matches the existing `lead_tags_added_by_id_idx` pattern and
-- silences `unindexed_foreign_keys` performance-advisor warnings.
CREATE INDEX IF NOT EXISTS "account_tags_added_by_id_idx" ON "account_tags" ("added_by_id") WHERE ("added_by_id" IS NOT NULL);
CREATE INDEX IF NOT EXISTS "contact_tags_added_by_id_idx" ON "contact_tags" ("added_by_id") WHERE ("added_by_id" IS NOT NULL);
CREATE INDEX IF NOT EXISTS "opportunity_tags_added_by_id_idx" ON "opportunity_tags" ("added_by_id") WHERE ("added_by_id" IS NOT NULL);
CREATE INDEX IF NOT EXISTS "task_tags_added_by_id_idx" ON "task_tags" ("added_by_id") WHERE ("added_by_id" IS NOT NULL);
