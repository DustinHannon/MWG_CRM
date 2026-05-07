import "server-only";
import ExcelJS from "exceljs";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/lead-constants";

/**
 * Phase 5G — migrated from `xlsx` (deprecated, two HIGH advisories) to
 * `exceljs`. Same on-disk output: a workbook with three sheets (Leads
 * sample data, field-by-field instructions, allowed enum values).
 */

const HEADERS = [
  "First Name*",
  "Last Name*",
  "Email",
  "Phone",
  "Mobile Phone",
  "Job Title",
  "Company",
  "Industry",
  "Website",
  "LinkedIn URL",
  "Street 1",
  "Street 2",
  "City",
  "State",
  "Postal Code",
  "Country",
  "Status",
  "Rating",
  "Source",
  "Estimated Value",
  "Estimated Close Date",
  "Description",
  "Tags",
  "Do Not Contact",
  "Do Not Email",
  "Do Not Call",
  "Owner Email",
  "External ID",
] as const;

const EXAMPLE_ROWS: string[][] = [
  [
    "Dusty",
    "Hannon",
    "dustin.hannon@morganwhite.com",
    "555-123-4567",
    "555-987-6543",
    "VP of IT/Security",
    "Morgan White Group",
    "Insurance",
    "https://morganwhite.com",
    "https://linkedin.com/in/dustinhannon",
    "100 Main St",
    "Suite 200",
    "Jackson",
    "MS",
    "39201",
    "USA",
    "qualified",
    "hot",
    "referral",
    "25000.00",
    "2026-09-01",
    "Met at industry event; interested in pilot",
    "vip,2026,pilot",
    "no",
    "no",
    "no",
    "",
    "D365-LEAD-12345",
  ],
  [
    "Jane",
    "Doe",
    "jane.doe@example.com",
    "555-000-0000",
    "",
    "Director of Marketing",
    "Example Corp",
    "Technology",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "new",
    "warm",
    "web",
    "",
    "",
    "Inbound from contact form",
    "",
    "no",
    "no",
    "no",
    "",
    "",
  ],
];

const INSTRUCTIONS: string[][] = [
  ["Field", "Required", "Notes"],
  ["First Name*", "Yes", "Lead's first name."],
  ["Last Name*", "Yes", "Lead's last name."],
  ["Email", "No", "Used for matching during import."],
  ["Phone", "No", "Free-form. Stored as text."],
  ["Mobile Phone", "No", "Free-form. Stored as text."],
  ["Job Title", "No", "Title at company."],
  ["Company", "No", "Company name."],
  ["Industry", "No", "e.g. Insurance, Technology, Healthcare."],
  ["Website", "No", "Full URL."],
  ["LinkedIn URL", "No", "Full URL."],
  ["Street 1 / Street 2", "No", "Address fields."],
  ["City / State / Postal Code / Country", "No", "Address fields."],
  ["Status", "No", `One of: ${LEAD_STATUSES.join(", ")} (default: new)`],
  ["Rating", "No", `One of: ${LEAD_RATINGS.join(", ")} (default: warm)`],
  ["Source", "No", `One of: ${LEAD_SOURCES.join(", ")} (default: import)`],
  ["Estimated Value", "No", "Numeric, USD. Decimal allowed. e.g. 25000 or 25000.00"],
  ["Estimated Close Date", "No", "Format: YYYY-MM-DD"],
  ["Description", "No", "Free-form notes."],
  ["Tags", "No", "Comma-separated. Becomes an array."],
  ["Do Not Contact / Email / Call", "No", "yes / no / true / false / blank"],
  ["Owner Email", "No", "Email of an existing user. Defaults to the importer's account."],
  ["External ID", "No", "D365 leadid or similar. Used for upsert: matching ID -> updated."],
];

const ALLOWED_VALUES: string[][] = [
  ["Status", ...LEAD_STATUSES],
  ["Rating", ...LEAD_RATINGS],
  ["Source", ...LEAD_SOURCES],
  ["Boolean fields", "yes", "no", "true", "false", "(blank)"],
];

export async function buildLeadImportTemplate(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MWG CRM";
  wb.created = new Date();

  const leadsSheet = wb.addWorksheet("Leads");
  leadsSheet.addRow(HEADERS as unknown as string[]);
  for (const row of EXAMPLE_ROWS) leadsSheet.addRow(row);
  leadsSheet.columns = HEADERS.map((h) => ({
    width: Math.max(12, Math.min(28, h.length + 4)),
  }));

  const instructionsSheet = wb.addWorksheet("Instructions");
  for (const row of INSTRUCTIONS) instructionsSheet.addRow(row);
  instructionsSheet.columns = [
    { width: 28 },
    { width: 12 },
    { width: 80 },
  ];

  const allowedSheet = wb.addWorksheet("Allowed Values");
  for (const row of ALLOWED_VALUES) allowedSheet.addRow(row);
  allowedSheet.columns = [
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
  ];

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
