// Plain constants — safe to import from client components.
// Order here drives status dropdown / filter ordering (logical pipeline order),
// independent of the underlying Postgres enum's insertion order. The three
// `*_contact` / `*_follow_up` / `recapture_*` values mirror the MWG D365 org's
// custom Open-state Status Reasons (see leadStatusEnum in db/schema/enums.ts).
export const LEAD_STATUSES = [
  "new",
  "attempting_contact",
  "contacted",
  "scheduled_follow_up",
  "recapture_termed",
  "qualified",
  "unqualified",
  "converted",
  "lost",
] as const;
export const LEAD_RATINGS = ["hot", "warm", "cold"] as const;
export const LEAD_SOURCES = [
  "web",
  "referral",
  "event",
  "cold_call",
  "partner",
  "marketing",
  "import",
  "other",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadRating = (typeof LEAD_RATINGS)[number];
export type LeadSource = (typeof LEAD_SOURCES)[number];
