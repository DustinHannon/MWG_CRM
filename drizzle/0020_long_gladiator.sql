-- Rebuild the import-dedup index as a partial UNIQUE index so the activity
-- import commit path (CSV/XLSX + D365) can use ON CONFLICT DO NOTHING against it.
-- Verified 0 existing duplicate (lead_id, import_dedup_key) groups before build.
DROP INDEX IF EXISTS "activities_import_dedup_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "activities_import_dedup_idx" ON "activities" USING btree ("lead_id","import_dedup_key") WHERE import_dedup_key IS NOT NULL;--> statement-breakpoint
-- Drift reconcile: these two FKs already exist in prod under Postgres-default
-- "_fkey" names; rename them to the drizzle-canonical names so the snapshot and
-- live schema agree (relationship + ON DELETE behavior unchanged).
ALTER TABLE "email_send_log" DROP CONSTRAINT IF EXISTS "email_send_log_retry_of_id_fkey";--> statement-breakpoint
ALTER TABLE "email_send_log" ADD CONSTRAINT "email_send_log_retry_of_id_email_send_log_id_fk" FOREIGN KEY ("retry_of_id") REFERENCES "public"."email_send_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_verification_status" DROP CONSTRAINT IF EXISTS "domain_verification_status_manually_confirmed_by_id_fkey";--> statement-breakpoint
ALTER TABLE "domain_verification_status" ADD CONSTRAINT "domain_verification_status_manually_confirmed_by_id_users_id_fk" FOREIGN KEY ("manually_confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;