CREATE TYPE "public"."activity_direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."activity_kind" AS ENUM('email', 'call', 'meeting', 'note', 'task');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."lead_rating" AS ENUM('hot', 'warm', 'cold');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('web', 'referral', 'event', 'cold_call', 'partner', 'marketing', 'import', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost');--> statement-breakpoint
CREATE TABLE "accounts" (
	"userId" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_pkey" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"can_view_all_leads" boolean DEFAULT false NOT NULL,
	"can_create_leads" boolean DEFAULT true NOT NULL,
	"can_edit_leads" boolean DEFAULT true NOT NULL,
	"can_delete_leads" boolean DEFAULT false NOT NULL,
	"can_import" boolean DEFAULT false NOT NULL,
	"can_export" boolean DEFAULT false NOT NULL,
	"can_send_email" boolean DEFAULT true NOT NULL,
	"can_view_reports" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entra_oid" text,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"display_name" text NOT NULL,
	"photo_blob_url" text,
	"photo_synced_at" timestamp with time zone,
	"is_breakglass" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"session_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_sent_items_sync_at" timestamp with time zone,
	"last_calendar_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"rating" "lead_rating" DEFAULT 'warm' NOT NULL,
	"source" "lead_source" DEFAULT 'other' NOT NULL,
	"salutation" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"job_title" text,
	"company_name" text,
	"industry" text,
	"email" text,
	"phone" text,
	"mobile_phone" text,
	"website" text,
	"linkedin_url" text,
	"street1" text,
	"street2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"estimated_value" numeric(14, 2),
	"estimated_close_date" date,
	"description" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"do_not_email" boolean DEFAULT false NOT NULL,
	"do_not_call" boolean DEFAULT false NOT NULL,
	"tags" text[],
	"external_id" text,
	"converted_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" "activity_kind" NOT NULL,
	"direction" "activity_direction",
	"subject" text,
	"body" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer,
	"outcome" text,
	"meeting_location" text,
	"meeting_attendees" jsonb,
	"graph_message_id" text,
	"graph_event_id" text,
	"graph_internet_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"blob_url" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"filename" text NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"successful_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"needs_review_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"request_id" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uniq" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uniq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_uniq" ON "users" USING btree ("entra_oid") WHERE entra_oid IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_breakglass" ON "users" USING btree ("is_breakglass") WHERE is_breakglass = true;--> statement-breakpoint
CREATE INDEX "leads_owner_idx" ON "leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "leads_company_idx" ON "leads" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "leads_external_id_idx" ON "leads" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "leads_last_activity_idx" ON "leads" USING btree ("last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_tags_gin_idx" ON "leads" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "activities_lead_occurred_idx" ON "activities" USING btree ("lead_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activities_user_idx" ON "activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activities_kind_idx" ON "activities" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_graph_message_uniq" ON "activities" USING btree ("graph_message_id") WHERE graph_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_graph_event_uniq" ON "activities" USING btree ("graph_event_id") WHERE graph_event_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_graph_intl_msg_uniq" ON "activities" USING btree ("graph_internet_message_id") WHERE graph_internet_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);