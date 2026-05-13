// Plain constants for the Opportunities saved-view system. Safe to
// import from client components — no DB imports. Mirrors
// `account-view-constants.ts` but with opportunity-specific columns
// and sort fields.

export const AVAILABLE_OPPORTUNITY_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "stage", label: "Stage" },
  { key: "account", label: "Account" },
  { key: "primaryContact", label: "Primary contact" },
  { key: "amount", label: "Amount" },
  { key: "probability", label: "Probability" },
  { key: "expectedCloseDate", label: "Expected close" },
  { key: "owner", label: "Owner" },
  { key: "closedAt", label: "Closed" },
  { key: "tags", label: "Tags" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" },
] as const;

export type OpportunityColumnKey =
  (typeof AVAILABLE_OPPORTUNITY_COLUMNS)[number]["key"];

export const OPPORTUNITY_COLUMN_KEYS: OpportunityColumnKey[] =
  AVAILABLE_OPPORTUNITY_COLUMNS.map((c) => c.key);

export const DEFAULT_OPPORTUNITY_COLUMNS: OpportunityColumnKey[] = [
  "name",
  "stage",
  "account",
  "amount",
  "probability",
  "expectedCloseDate",
  "owner",
];

export const OPPORTUNITY_SORT_FIELDS = [
  "name",
  "stage",
  "amount",
  "probability",
  "expectedCloseDate",
  "closedAt",
  "createdAt",
  "updatedAt",
] as const;

export type OpportunitySortField =
  (typeof OPPORTUNITY_SORT_FIELDS)[number];
