ALTER TABLE "user_preferences" ADD COLUMN "notifications_last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "verb" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "entity_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "entity_display_name" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);