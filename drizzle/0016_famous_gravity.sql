ALTER TABLE "email_send_log" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_send_dedupe_key_idx" ON "email_send_log" USING btree ("dedupe_key") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mkt_rcpt_campaign_email_uniq" ON "marketing_campaign_recipients" USING btree ("campaign_id",lower("email"));