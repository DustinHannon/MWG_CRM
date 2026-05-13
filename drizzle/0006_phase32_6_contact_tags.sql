CREATE TABLE IF NOT EXISTS "contact_tags" (
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "added_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("contact_id", "tag_id")
);
CREATE INDEX IF NOT EXISTS "contact_tags_tag_idx" ON "contact_tags" ("tag_id");
