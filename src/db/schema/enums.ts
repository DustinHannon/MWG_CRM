import { pgEnum } from "drizzle-orm/pg-core";

// Lead lifecycle. `converted` is the v1 terminal "won" state — we don't have
// separate Account/Contact/Opportunity tables yet (v2).
//
// `attempting_contact` / `scheduled_follow_up` / `recapture_termed` mirror the
// MWG D365 org's custom Open-state Status Reasons 1:1 so an imported lead shows
// its real D365 working status instead of being collapsed into `contacted`
// (added 2026-06-16). New values are APPENDED (Postgres ALTER TYPE ADD VALUE
// appends) — this array's order must match the live enum's insertion order.
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "converted",
  "lost",
  "attempting_contact",
  "scheduled_follow_up",
  "recapture_termed",
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
  // parsed and shown to the user; awaiting commit decision.
  "preview",
  "completed",
  "failed",
  // user dismissed without committing.
  "cancelled",
]);

// How a lead row was first created. `imported` rows always carry an
// `import_job_id`; `api` is reserved for a future public API.
export const leadCreationMethodEnum = pgEnum("lead_creation_method", [
  "manual",
  "imported",
  "api",
]);
