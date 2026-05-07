// Plain constants — safe to import from client components.
export const LEAD_STATUSES = [
  "new",
  "contacted",
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
