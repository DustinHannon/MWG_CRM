-- Phase 29 §7 — ClickDimensions template-migration worklist.
--
-- Reversible (CREATE TYPE / CREATE TABLE / CREATE INDEX). Per Phase 27
-- "Allowed with safeguards", reversible migrations ship without sign-off.

CREATE TYPE "public"."clickdimensions_editor_type" AS ENUM (
  'custom-html',
  'free-style',
  'email-designer',
  'drag-and-drop',
  'unknown'
);--> statement-breakpoint

CREATE TYPE "public"."clickdimensions_migration_status" AS ENUM (
  'pending',
  'extracted',
  'imported',
  'failed',
  'skipped'
);--> statement-breakpoint

CREATE TABLE "clickdimensions_migrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cd_template_id" uuid NOT NULL,
  "cd_template_name" text NOT NULL,
  "cd_subject" text,
  "cd_category" text,
  "cd_owner" text,
  "cd_created_at" timestamp with time zone,
  "cd_modified_at" timestamp with time zone,
  "editor_type" "clickdimensions_editor_type" DEFAULT 'unknown' NOT NULL,
  "raw_html" text,
  "status" "clickdimensions_migration_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "extracted_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "imported_template_id" uuid,
  "error_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "clickdimensions_migrations_cd_template_id_unique" UNIQUE("cd_template_id")
);--> statement-breakpoint

ALTER TABLE "clickdimensions_migrations"
  ADD CONSTRAINT "clickdimensions_migrations_imported_template_id_fk"
  FOREIGN KEY ("imported_template_id")
  REFERENCES "public"."marketing_templates"("id")
  ON DELETE set null
  ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "cd_mig_status_idx"
  ON "clickdimensions_migrations" USING btree (
    "status",
    "extracted_at" DESC
  );--> statement-breakpoint

CREATE INDEX "cd_mig_extracted_idx"
  ON "clickdimensions_migrations" USING btree (
    "extracted_at" DESC
  );--> statement-breakpoint

CREATE INDEX "cd_mig_imported_idx"
  ON "clickdimensions_migrations" USING btree (
    "imported_template_id"
  );--> statement-breakpoint

-- Match project-wide pattern: RLS enabled, no policies. Application
-- code does access control; RLS just prevents direct PostgREST exposure.
ALTER TABLE "clickdimensions_migrations" ENABLE ROW LEVEL SECURITY;
