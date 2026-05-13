CREATE TABLE IF NOT EXISTS "task_tags" (
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "added_by_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "task_tags_pkey" PRIMARY KEY ("task_id", "tag_id")
);
CREATE INDEX IF NOT EXISTS "task_tags_tag_idx" ON "task_tags" ("tag_id");
