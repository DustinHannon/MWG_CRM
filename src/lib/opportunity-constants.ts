/**
 * Phase 9C (workflow) — opportunity stage labels. Lives in its own
 * module (not in `@/lib/opportunities`) because the latter is
 * `server-only` and the new opportunity client form needs the list
 * for the stage `<select>`. Mirrors the `opportunity_stage` Postgres
 * enum verbatim.
 */
export const OPPORTUNITY_STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];
