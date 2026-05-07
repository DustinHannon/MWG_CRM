import { pgEnum } from "drizzle-orm/pg-core";

// Lead lifecycle. `converted` is the v1 terminal "won" state — we don't have
// separate Account/Contact/Opportunity tables yet (v2).
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "converted",
  "lost",
]);

export const leadRatingEnum = pgEnum("lead_rating", ["hot", "warm", "cold"]);

export const leadSourceEnum = pgEnum("lead_source", [
  "web",
  "referral",
  "event",
  "cold_call",
  "partner",
  "marketing",
  "import",
  "other",
]);

export const activityKindEnum = pgEnum("activity_kind", [
  "email",
  "call",
  "meeting",
  "note",
  "task",
]);

export const activityDirectionEnum = pgEnum("activity_direction", [
  "inbound",
  "outbound",
  "internal",
]);

export const importStatusEnum = pgEnum("import_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

// How a lead row was first created. `imported` rows always carry an
// `import_job_id`; `api` is reserved for a future public API.
export const leadCreationMethodEnum = pgEnum("lead_creation_method", [
  "manual",
  "imported",
  "api",
]);
