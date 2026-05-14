import "server-only";
import ExcelJS from "exceljs";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/lead-constants";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import { TEMPLATE_HEADERS } from "@/lib/import/headers";

/**
 * three-sheet template generated for the new 39-column
 * import structure (§4 of the brief). Sheets:
 *
 * Leads : headers + 3 example rows (minimal / typical / rich)
 * Instructions : column docs + multi-line activity format + mappings
 * Allowed values: status / rating / opportunity stage enums
 *
 * The "rich" example demonstrates the multi-line activity column shape
 * exceljs preserves embedded \n inside a cell and the import parser
 * recognises that as activity boundaries. Users open the template,
 * paste their data, and submit it on /leads/import.
 */

const HEADERS = TEMPLATE_HEADERS.map((h) =>
  h.required ? `${h.header}*` : h.header,
);

const RICH_NOTES = `[2026-02-01 09:00 AM CT] — by Tanzania Griffith follow-up after dental quote sent`;

const RICH_CALLS = `[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  Lead called wanting a family plan without copays.
  Quoted BrightSmile Elite. Enrollment must be online.

[2026-02-15 10:30 AM CT] Follow-up
  Outgoing | Left Voicemail | By: Tanzania Griffith`;

const RICH_MEETINGS = `[2026-02-20 03:00 PM CT] Plan walkthrough
  Status: Completed | End: 2026-02-20 03:30 PM CT | Duration: 30 min | Owner: Tanzania Griffith
  Attendees: Tanzania Griffith, Dustin Hannon`;

// 3 sample rows — minimal / typical / rich-with-multiline-activities.
const EXAMPLE_ROWS: Array<Record<string, string>> = [
  // 1. Minimal — just the required field, plus an email so the lead is
  // identifiable.
  {
    firstName: "Amy",
    lastName: "",
    email: "amy@example.com",
  },
  // 2. Typical — most common columns populated.
  {
    firstName: "Dusty",
    lastName: "Hannon",
    email: "dustin.hannon@morganwhite.com",
    phone: "(601) 555-1234",
    mobilePhone: "(601) 555-5678",
    jobTitle: "VP of IT/Security",
    companyName: "Morgan White Group",
    industry: "Insurance",
    website: "https://morganwhite.com",
    linkedinUrl: "https://linkedin.com/in/dustinhannon",
    street1: "100 Main St",
    street2: "Suite 200",
    city: "Jackson",
    state: "MS",
    postalCode: "39201",
    country: "USA",
    status: "qualified",
    rating: "hot",
    source: "referral",
    estimatedValue: "12500.00",
    estimatedCloseDate: "2026-06-15",
    subject: "Group dental refresh",
    description:
      "Existing customer asking about adding optional vision rider to their dental group plan.",
    tags: "VIP, Q2-renewal",
    doNotContact: "false",
    doNotEmail: "false",
    doNotCall: "false",
    ownerEmail: "dustin.hannon@morganwhite.com",
    externalId: "MWG-LEAD-0001",
  },
  // 3. Rich — multi-line activity columns + opportunity columns.
  {
    firstName: "Bettina",
    lastName: "Overbeck",
    email: "bettina@example.com",
    phone: "(212) 555-3344",
    companyName: "Overbeck & Co",
    status: "qualified",
    rating: "warm",
    source: "import",
    subject: "Snarky",
    notes: RICH_NOTES,
    phoneCalls: RICH_CALLS,
    meetings: RICH_MEETINGS,
    oppName: "Overbeck — group dental",
    oppStage: "prospecting",
    oppProbability: "10",
    oppAmount: "9500",
    oppOwnerEmail: "dustin.hannon@morganwhite.com",
    tags: "renewal, group",
    ownerEmail: "dustin.hannon@morganwhite.com",
    externalId: "MWG-LEAD-0002",
  },
];

function rowFor(record: Record<string, string>): string[] {
  return TEMPLATE_HEADERS.map((h) => record[h.field] ?? "");
}

export async function buildLeadImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MWG CRM";
  wb.created = new Date();

  // ---- Sheet 1: Leads ---------------------------------------------------
  const leadsSheet = wb.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  leadsSheet.addRow(HEADERS);
  for (const ex of EXAMPLE_ROWS) leadsSheet.addRow(rowFor(ex));
  leadsSheet.getRow(1).font = { bold: true };
  // Multi-line columns deserve a wrap-text + width so users can see
  // their content. Exceljs respects \n if alignment.wrapText is true.
  leadsSheet.columns = TEMPLATE_HEADERS.map((h) => ({
    header: h.header,
    key: h.field,
    width: ["notes", "phoneCalls", "meetings", "emails", "description"].includes(
      h.field,
    )
      ? 50
      : 18,
    style: { alignment: { wrapText: true, vertical: "top" } },
  }));

  // ---- Sheet 2: Instructions -------------------------------------------
  const instr = wb.addWorksheet("Instructions");
  instr.addRow(["Column", "Required", "Format / notes"]);
  instr.getRow(1).font = { bold: true };
  for (const h of TEMPLATE_HEADERS) {
    instr.addRow([
      h.header,
      h.required ? "Yes" : "No",
      h.notes ?? "",
    ]);
  }
  instr.columns = [{ width: 32 }, { width: 12 }, { width: 70 }];

  instr.addRow([]);
  instr.addRow([
    "Multi-line activity columns (Notes, Phone Calls, Meetings, Emails)",
  ]);
  instr.getRow(instr.rowCount).font = { bold: true };
  instr.addRow([
    "Each activity starts on a new line beginning with a timestamp in square brackets:",
  ]);
  instr.addRow([
    `[2026-01-29 02:54 PM UTC] Dental Quote\n  Outgoing | Duration: 30 min | By: Tanzania Griffith\n  Lead called wanting a family plan without copays.\n\n[2026-02-15 10:30 AM CT] Follow-up\n  Outgoing | Left Voicemail | By: Tanzania Griffith`,
  ]);
  instr.getRow(instr.rowCount).alignment = { wrapText: true, vertical: "top" };
  instr.addRow([]);
  instr.addRow(["Lead status mapping (when 'Status' is a D365 value)"]);
  instr.getRow(instr.rowCount).font = { bold: true };
  for (const [from, to] of [
    ["Open", "new"],
    ["Attempting Contact", "contacted"],
    ["Qualified", "qualified"],
    ["Not Interested", "unqualified"],
    ["No Response", "unqualified"],
    ["Lost", "lost"],
  ] as const) {
    instr.addRow([from, "→", to]);
  }
  instr.addRow([]);
  instr.addRow(["Opportunity stage mapping (Linked Opportunity Stage)"]);
  instr.getRow(instr.rowCount).font = { bold: true };
  for (const [from, to] of [
    ["In Progress", "prospecting"],
    ["Won", "closed_won"],
    ["Lost", "closed_lost"],
    ["On Hold", "qualification"],
    ["Cancelled", "closed_lost"],
  ] as const) {
    instr.addRow([from, "→", to]);
  }
  instr.addRow([]);
  instr.addRow([
    "Smart-detect mode (legacy D365 dump)",
  ]);
  instr.getRow(instr.rowCount).font = { bold: true };
  instr.addRow([
    "If your file came out of D365 with everything (Topic, Phone Calls, Notes, Linked Opportunity, Description) crammed into the Description column, enable smart-detect on the import preview screen. The importer will split it into the proper structured columns at parse time. Going forward, prefer the dedicated columns above for new exports.",
  ]);
  instr.getRow(instr.rowCount).alignment = { wrapText: true, vertical: "top" };

  // ---- Sheet 3: Allowed values -----------------------------------------
  const enums = wb.addWorksheet("Allowed values");
  enums.addRow(["Field", "Allowed values"]);
  enums.getRow(1).font = { bold: true };
  enums.addRow(["Status", LEAD_STATUSES.join(", ")]);
  enums.addRow(["Rating", LEAD_RATINGS.join(", ")]);
  enums.addRow(["Source", LEAD_SOURCES.join(", ")]);
  enums.addRow([
    "Linked Opportunity Stage",
    OPPORTUNITY_STAGES.join(", "),
  ]);
  enums.columns = [{ width: 28 }, { width: 80 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
