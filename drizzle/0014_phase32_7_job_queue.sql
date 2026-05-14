CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "job_queue_dead_letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_count" integer NOT NULL,
	"failure_reason" text NOT NULL,
	"last_error" text,
	"enqueued_at" timestamp with time zone NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"original_metadata" jsonb,
	"actor_id" uuid
);
--> statement-breakpoint
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "job_queue_dead_letter" ADD CONSTRAINT "job_queue_dead_letter_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "job_queue_claim_idx" ON "job_queue" USING btree ("kind","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "job_queue_stale_claim_idx" ON "job_queue" USING btree ("claimed_at") WHERE status = 'processing';--> statement-breakpoint
CREATE INDEX "job_queue_status_kind_idx" ON "job_queue" USING btree ("status","kind","enqueued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "job_queue_idempotency_key_idx" ON "job_queue" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_queue_dead_letter_kind_idx" ON "job_queue_dead_letter" USING btree ("kind","failed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_queue_dead_letter_failed_at_idx" ON "job_queue_dead_letter" USING btree ("failed_at" DESC NULLS LAST);