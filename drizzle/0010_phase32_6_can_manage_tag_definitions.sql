ALTER TABLE "permissions" ADD COLUMN IF NOT EXISTS "can_manage_tag_definitions" boolean NOT NULL DEFAULT false;
