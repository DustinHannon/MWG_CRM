CREATE TABLE "supabase_metrics" (
	"time" timestamp with time zone NOT NULL,
	"metric_name" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"value" double precision NOT NULL
);
--> statement-breakpoint
CREATE INDEX "supabase_metrics_time_brin" ON "supabase_metrics" USING brin ("time");--> statement-breakpoint
CREATE INDEX "supabase_metrics_metric_time" ON "supabase_metrics" USING btree ("metric_name","time" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "supabase_metrics" ENABLE ROW LEVEL SECURITY;