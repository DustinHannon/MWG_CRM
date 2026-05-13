CREATE TABLE IF NOT EXISTS "opportunity_tags" (
  "opportunity_id" uuid NOT NULL REFERENCES "opportunities"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "added_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "opportunity_tags_pkey" PRIMARY KEY ("opportunity_id", "tag_id")
);
CREATE INDEX IF NOT EXISTS "opportunity_tags_tag_idx" ON "opportunity_tags" ("tag_id");
