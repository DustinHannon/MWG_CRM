-- Phase 29 §4 — Template visibility scoping (Sub-agent A).
--
-- Adds a `scope` enum (global|personal) and a `source` text marker to
-- `marketing_templates`. Backfills existing rows to (scope='global',
-- source='manual') so pre-Phase-29 behavior is preserved.
--
-- Also relaxes `marketing_campaigns.template_id` to nullable so the
-- personal-template deletion cascade (Phase 29 §4.8) can set the FK
-- to NULL on draft campaigns instead of refusing the delete.
--
-- Reversible:
--   DROP INDEX mkt_tpl_scope_created_by_idx;
--   ALTER TABLE marketing_templates DROP COLUMN scope;
--   ALTER TABLE marketing_templates DROP COLUMN source;
--   DROP TYPE marketing_template_scope;
--   ALTER TABLE marketing_campaigns ALTER COLUMN template_id SET NOT NULL;

CREATE TYPE "public"."marketing_template_scope" AS ENUM ('global', 'personal');--> statement-breakpoint
ALTER TABLE "marketing_templates"
  ADD COLUMN "scope" "marketing_template_scope" NOT NULL DEFAULT 'global';--> statement-breakpoint
ALTER TABLE "marketing_templates"
  ADD COLUMN "source" text NOT NULL DEFAULT 'manual';--> statement-breakpoint
CREATE INDEX "mkt_tpl_scope_created_by_idx"
  ON "marketing_templates" ("scope", "created_by_id");--> statement-breakpoint
ALTER TABLE "marketing_campaigns"
  ALTER COLUMN "template_id" DROP NOT NULL;
