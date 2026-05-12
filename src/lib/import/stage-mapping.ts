// D365 → MWG opportunity stage / lead status mapping.
// Hard-coded; if the D365 export shape changes, edit this file.

import { LEAD_STATUSES } from "@/lib/lead-constants";

export const D365_STATUS_TO_OPP_STAGE: Record<string, string> = {
  "In Progress": "prospecting",
  "Won": "closed_won",
  "Lost": "closed_lost",
  "On Hold": "qualification",
  "Cancelled": "closed_lost",
};

export type LeadStatusEnum = (typeof LEAD_STATUSES)[number];

export const D365_STATUS_TO_LEAD_STATUS: Record<string, LeadStatusEnum> = {
  "Open": "new",
  "Attempting Contact": "contacted",
  "Qualified": "qualified",
  "Not Interested": "unqualified",
  "No Response": "unqualified",
  "Lost": "lost",
};

/**
 * Map a raw D365 lead status to ours, falling back to "new" with an
 * indication that the input was not in the known mapping table.
 */
export function mapLeadStatus(raw: string | null | undefined): {
  status: LeadStatusEnum;
  fallback: boolean;
  rawValue: string | null;
} {
  const rawValue = raw?.trim() || null;
  if (!rawValue) return { status: "new", fallback: false, rawValue: null };
  const exact = D365_STATUS_TO_LEAD_STATUS[rawValue];
  if (exact) return { status: exact, fallback: false, rawValue };
  return { status: "new", fallback: true, rawValue };
}

export function mapOpportunityStage(raw: string | null | undefined): {
  stage: string;
  fallback: boolean;
  rawValue: string | null;
} {
  const rawValue = raw?.trim() || null;
  if (!rawValue) return { stage: "prospecting", fallback: true, rawValue };
  const exact = D365_STATUS_TO_OPP_STAGE[rawValue];
  if (exact) return { stage: exact, fallback: false, rawValue };
  return { stage: "prospecting", fallback: true, rawValue };
}
