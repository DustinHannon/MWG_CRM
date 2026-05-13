// Generates a synthetic test workbook that exercises every code path
// the production batch-0447 file is supposed to hit: Topic-only rows,
// Phone Calls multi-line cells, Linked Opportunity blocks, NULL
// last_name, unresolvable owner names, voicemail (no duration)
// variant, meeting with attendees + duplicates.
//
// Output: ./test-data/mwg-crm-leads-batch-synthetic.xlsx
//
// Run with: pnpm dlx tsx scripts/import-smoke-build.ts

import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TEMPLATE_HEADERS } from "../src/lib/import/headers";

const HEADERS = TEMPLATE_HEADERS.map((h) =>
  h.required ? `${h.header}*` : h.header,
);

interface Row {
  [field: string]: string;
}

const rows: Row[] = [
  // 1. Bettina Overbeck — meeting + 2 calls. Smoke spot-check #1.
  {
    firstName: "Bettina",
    lastName: "Overbeck",
    email: "bettina@overbeck.test",
    phone: "(212) 555-3344",
    companyName: "Overbeck & Co",
    status: "Qualified", // D365 spelling — exercises mapping
    rating: "warm",
    description: `Topic: Renewal cycle review

Phone Calls:
[2024-12-17 03:00 PM UTC] Renewal call
  Outgoing | Duration: 25 min | By: Tanzania Griffith
  Reviewed renewal options for group dental.

[2024-12-18 08:50 PM UTC] Follow-up
  Outgoing | Left Voicemail | By: Tanzania Griffith

Appointments:
[2024-12-18 08:30 PM UTC] Plan walkthrough
  Status: Completed | End: 2024-12-18 08:50 PM UTC | Duration: 20 min | Owner: Tanzania Griffith
  Attendees: Tanzania Griffith, Bettina Overbeck`,
    ownerEmail: "tanzania.griffith@morganwhite.test",
    externalId: "TEST-BETTINA-001",
  },
  // 2. John Costanzo — Topic + Linked Opportunity + Phone Call (Snarky).
  {
    firstName: "John",
    lastName: "Costanzo",
    email: "john@costanzo.test",
    description: `Topic: Snarky

Linked Opportunity:
Name:        Snarky
Status:      In Progress
Probability: 10%
Owner:       Tanzania Griffith

Phone Calls:
[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  Lead called wanting BEST dental plan w/o copays`,
    ownerEmail: "tanzania.griffith@morganwhite.test",
    externalId: "TEST-COSTANZO-002",
  },
  // 3. Mr. (None) — single Note from 2020-04-21 by Rafael Somarriba.
  {
    firstName: "Mr.",
    lastName: "(None)",
    description: `Notes:
[2020-04-21 09:15 AM CST] — by Rafael Somarriba initial inbound about group dental`,
    ownerEmail: "rafael.somarriba@morganwhite.test",
    externalId: "TEST-MR-NONE-003",
  },
  // 4. Mary Sue Smith — compound last_name, exercises rendering.
  {
    firstName: "Mary",
    lastName: "Sue Smith",
    email: "mary@sue-smith.test",
    externalId: "TEST-MARY-004",
  },
  // 5. Amy — NULL last_name. Last-name nullability check.
  {
    firstName: "Amy",
    email: "amy@example.test",
    phone: "(601) 555-7777",
    externalId: "TEST-AMY-005",
  },
  // 6. Unresolvable owner — Nicole Cornish is a former employee, no
  //    matching email. Should warn + leave unowned.
  {
    firstName: "Lead",
    lastName: "Six",
    description: `Notes:
[2024-08-02 10:00 AM CT] — by Nicole Cornish prospected at trade show`,
    ownerEmail: "broker@oldagency.test",
    externalId: "TEST-LEAD6-006",
  },
  // 7. Hard-fail — neither firstName NOR email. Should be skipped.
  {
    lastName: "Orphan",
    externalId: "TEST-ORPHAN-007",
  },
  // 8. Pending status — D365 status not in our map.
  {
    firstName: "Pending",
    lastName: "Status",
    email: "pending@example.test",
    status: "Pending",
    externalId: "TEST-PENDING-008",
  },
];

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Leads");
  sheet.addRow(HEADERS);
  for (const r of rows) {
    sheet.addRow(
      TEMPLATE_HEADERS.map((h) => r[h.field] ?? ""),
    );
  }
  // Wrap-text on multi-line cells.
  for (let i = 2; i <= sheet.rowCount; i++) {
    sheet.getRow(i).alignment = { wrapText: true, vertical: "top" };
  }
  const buf = await wb.xlsx.writeBuffer();
  const outDir = path.join(process.cwd(), "test-data");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "mwg-crm-leads-batch-synthetic.xlsx");
  await writeFile(outFile, Buffer.from(buf));
  console.log(`Wrote ${outFile} (${rows.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
