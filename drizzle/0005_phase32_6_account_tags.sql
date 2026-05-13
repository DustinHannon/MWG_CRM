CREATE TABLE IF NOT EXISTS "account_tags" (
  "account_id" uuid NOT NULL REFERENCES "crm_accounts"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "added_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "account_tags_pkey" PRIMARY KEY ("account_id", "tag_id")
);
CREATE INDEX IF NOT EXISTS "account_tags_tag_idx" ON "account_tags" ("tag_id");
