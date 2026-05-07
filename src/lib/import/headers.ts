// Phase 6E — canonical header→field mapping for the new 39-column
// import template. Header strings are matched case-insensitively after
// trim. Trailing asterisk on a header (e.g., "First Name*") is also
// matched. Unknown headers are silently ignored — the importer logs a
// warning if any required field is missing.

export interface HeaderMapEntry {
  field: string;
  required?: boolean;
}

// Order matters for the downloadable template (Phase 6G).
export const TEMPLATE_HEADERS: Array<{
  header: string;
  field: string;
  required?: boolean;
  notes?: string;
}> = [
  { header: "First Name", field: "firstName", required: true },
  { header: "Last Name", field: "lastName", notes: "Now nullable" },
  { header: "Email", field: "email" },
  { header: "Phone", field: "phone", notes: "Normalized to E.164" },
  { header: "Mobile Phone", field: "mobilePhone" },
  { header: "Job Title", field: "jobTitle" },
  { header: "Company", field: "companyName" },
  { header: "Industry", field: "industry" },
  { header: "Website", field: "website", notes: "http/https only" },
  { header: "LinkedIn URL", field: "linkedinUrl" },
  { header: "Street 1", field: "street1" },
  { header: "Street 2", field: "street2" },
  { header: "City", field: "city" },
  { header: "State", field: "state" },
  { header: "Postal Code", field: "postalCode" },
  { header: "Country", field: "country" },
  { header: "Status", field: "status" },
  { header: "Rating", field: "rating" },
  { header: "Source", field: "source" },
  { header: "Estimated Value", field: "estimatedValue" },
  { header: "Estimated Close Date", field: "estimatedCloseDate" },
  { header: "Subject", field: "subject", notes: "1-1000 chars" },
  { header: "Description", field: "description" },
  {
    header: "Notes",
    field: "notes",
    notes: "Multi-line; see Instructions sheet",
  },
  {
    header: "Phone Calls",
    field: "phoneCalls",
    notes: "Multi-line; see Instructions sheet",
  },
  {
    header: "Meetings",
    field: "meetings",
    notes: "Multi-line; see Instructions sheet",
  },
  {
    header: "Emails",
    field: "emails",
    notes: "Multi-line; see Instructions sheet",
  },
  {
    header: "Last Activity Date",
    field: "lastActivityAt",
    notes: "Manual override; usually computed from imported activities",
  },
  { header: "Linked Opportunity Name", field: "oppName" },
  { header: "Linked Opportunity Stage", field: "oppStage" },
  {
    header: "Linked Opportunity Probability",
    field: "oppProbability",
    notes: "0-100 integer",
  },
  { header: "Linked Opportunity Amount", field: "oppAmount" },
  { header: "Linked Opportunity Owner Email", field: "oppOwnerEmail" },
  { header: "Tags", field: "tags", notes: "Comma-separated, autocreates" },
  { header: "Do Not Contact", field: "doNotContact" },
  { header: "Do Not Email", field: "doNotEmail" },
  { header: "Do Not Call", field: "doNotCall" },
  { header: "Owner Email", field: "ownerEmail" },
  {
    header: "External ID",
    field: "externalId",
    notes: "For re-import idempotency",
  },
];

const NORMALISED_HEADER_MAP: Map<string, HeaderMapEntry> = new Map();
for (const entry of TEMPLATE_HEADERS) {
  NORMALISED_HEADER_MAP.set(normaliseHeader(entry.header), {
    field: entry.field,
    required: entry.required,
  });
}

// Backwards compatibility: legacy templates used "Company" + "First Name*"
// + "Last Name*". Already covered by the trailing-* normaliser below.

export function normaliseHeader(raw: string): string {
  return raw.trim().replace(/\*+$/, "").trim().toLowerCase();
}

export function lookupHeader(raw: string): HeaderMapEntry | undefined {
  return NORMALISED_HEADER_MAP.get(normaliseHeader(raw));
}
