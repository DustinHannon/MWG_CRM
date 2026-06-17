// Plain constants — safe to import from client components.
// Order here drives status dropdown / filter ordering (logical pipeline order),
// independent of the underlying Postgres enum's insertion order. The three
// `*_contact` / `*_follow_up` / `recapture_*` values mirror the MWG D365 org's
// custom Open-state Status Reasons (see leadStatusEnum in db/schema/enums.ts).
export const LEAD_STATUSES = [
  "new",
  "open",
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

/**
 * Terminal (closed) lead statuses — a lead in one of these is no longer in the
 * active pipeline. Single source of truth for the "open vs closed" bucket used
 * by the dashboard KPIs, the "My Open Leads" view, and the user-profile
 * open-leads count. Everything in LEAD_STATUSES NOT listed here is "open".
 */
export const TERMINAL_LEAD_STATUSES = [
  "unqualified",
  "converted",
  "lost",
] as const;

/**
 * Open / active-pipeline lead statuses — derived as LEAD_STATUSES minus the
 * terminal set, so a future status addition is automatically treated as open
 * unless it is explicitly added to TERMINAL_LEAD_STATUSES. Drives the "open
 * leads" definition everywhere so the dashboard, the My-Open view, and the
 * profile count cannot drift apart.
 */
export const OPEN_LEAD_STATUSES: LeadStatus[] = LEAD_STATUSES.filter(
  (s) => !(TERMINAL_LEAD_STATUSES as readonly string[]).includes(s),
);

/**
 * Human display labels for each lead status (sentence case). Typed
 * `Record<LeadStatus, string>` so adding a status to the enum forces a label
 * here at compile time. Single source for the status pill and any plain-text
 * status render (e.g. the print/PDF view).
 */
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  open: "Open",
  attempting_contact: "Attempting contact",
  contacted: "Contacted",
  scheduled_follow_up: "Scheduled follow-up",
  recapture_termed: "Recapture termed",
  qualified: "Qualified",
  unqualified: "Unqualified",
  converted: "Converted",
  lost: "Lost",
};
