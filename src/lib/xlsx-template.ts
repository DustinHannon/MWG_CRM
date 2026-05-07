import "server-only";
import * as XLSX from "xlsx";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/lead-constants";

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

const EXAMPLE_ROWS = [
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

const INSTRUCTIONS = [
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

const ALLOWED_VALUES = [
  ["Status", ...LEAD_STATUSES],
  ["Rating", ...LEAD_RATINGS],
  ["Source", ...LEAD_SOURCES],
  ["Boolean fields", "yes", "no", "true", "false", "(blank)"],
];

export function buildLeadImportTemplate(): Uint8Array {
  const wb = XLSX.utils.book_new();

  const leadsSheet = XLSX.utils.aoa_to_sheet([
    HEADERS as unknown as string[],
    ...EXAMPLE_ROWS,
  ]);
  // Set reasonable column widths (in characters).
  leadsSheet["!cols"] = HEADERS.map((h) => ({
    wch: Math.max(12, Math.min(28, h.length + 4)),
  }));
  XLSX.utils.book_append_sheet(wb, leadsSheet, "Leads");

  const instructionsSheet = XLSX.utils.aoa_to_sheet(INSTRUCTIONS);
  instructionsSheet["!cols"] = [{ wch: 28 }, { wch: 12 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, instructionsSheet, "Instructions");

  const allowedSheet = XLSX.utils.aoa_to_sheet(ALLOWED_VALUES);
  allowedSheet["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, allowedSheet, "Allowed Values");

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(buf);
}
