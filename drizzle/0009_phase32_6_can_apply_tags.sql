ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "can_apply_tags" boolean NOT NULL DEFAULT false;
