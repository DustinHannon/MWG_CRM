// Schema barrel — imported by the Drizzle client (src/db/index.ts) and by
// drizzle-kit (drizzle.config.ts).
export * from "./enums";
export * from "./users";
export * from "./leads";
export * from "./activities";
export * from "./imports";
export * from "./audit";
export * from "./views";
export * from "./tags";
export * from "./tasks";
export * from "./crm-records";
export * from "./saved-search-subscriptions";
export * from "./recent-views";
export * from "./lead-scoring";
export * from "./saved-reports";
export * from "./api-keys";
export * from "./email-send-log";
// Marketing email subsystem (SendGrid + Unlayer)
export * from "./marketing-templates";
export * from "./marketing-lists";
export * from "./marketing-campaigns";
export * from "./marketing-events";
// Security primitives (rate limiting + webhook idempotency)
export * from "./security";
// D365 CRM import pipeline (external IDs + run/batch/record state)
export * from "./d365-imports";
// ClickDimensions template-migration worklist
export * from "./clickdimensions-migrations";
// Static-list Excel import runs (Sub-agent C)
export * from "./list-import-runs";
// Domain migration external-service verification tracker
export * from "./domain-verification";
