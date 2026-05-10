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
// Phase 19 — Marketing email subsystem (SendGrid + Unlayer)
export * from "./marketing-templates";
export * from "./marketing-lists";
export * from "./marketing-campaigns";
export * from "./marketing-events";
// Phase 20 — Security primitives (rate limiting + webhook idempotency)
export * from "./security";
// Phase 23 — D365 CRM import pipeline (external IDs + run/batch/record state)
export * from "./d365-imports";
