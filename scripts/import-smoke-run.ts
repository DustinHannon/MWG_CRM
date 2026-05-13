// Runs the import pipeline (parse + preview build) against a workbook
// on disk and dumps the preview. Does NOT commit — write path requires
// DB access via the server-only db client which would fail outside a
// Next runtime.
//
// Usage:
//   pnpm dlx tsx scripts/import-smoke-run.ts [path-to-xlsx]
//
// Default path: ./test-data/mwg-crm-leads-batch-synthetic.xlsx
// To smoke the production batch: pass the absolute path of
// mwg-crm-leads-batch-0447.xlsx as the first argument.

import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { lookupHeader } from "../src/lib/import/headers";
import { parseImportRow } from "../src/lib/import/parse-row";

async function main(): Promise<void> {
  const filePath =
    process.argv[2] ??
    path.join(process.cwd(), "test-data", "mwg-crm-leads-batch-synthetic.xlsx");
  const smartDetect = process.argv.includes("--smart") || true; // default on

  const buf = await readFile(filePath);
  const wb = new ExcelJS.Workbook();
  // @ts-expect-error -- ExcelJS Buffer typing mismatch
  await wb.xlsx.load(new Uint8Array(buf));
  const sheet =
    wb.worksheets.find((s) => s.name.toLowerCase() === "leads") ??
    wb.worksheets[0];

  const headerRow = sheet.getRow(1);
  const headers: Array<{ raw: string; field: string | null }> = [];
  for (let c = 1; c <= sheet.columnCount; c++) {
    const v = headerRow.getCell(c).value;
    const raw = v == null ? "" : String(v).trim();
    if (raw.length === 0) {
      headers.push({ raw, field: null });
      continue;
    }
    const m = lookupHeader(raw);
    headers.push({ raw, field: m?.field ?? null });
  }

  const rowResults: Array<
    | { rowNumber: number; ok: true; counts: Record<string, number> }
    | { rowNumber: number; ok: false; errors: string[] }
  > = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row || row.cellCount === 0) continue;
    const data: Record<string, string> = {};
    let hasAny = false;
    for (let c = 1; c <= headers.length; c++) {
      const h = headers[c - 1];
      if (!h.field) continue;
      const v = row.getCell(c).value;
      const text =
        v == null
          ? ""
          : v instanceof Date
            ? v.toISOString()
            : typeof v === "object" && v !== null && "text" in v && typeof (v as { text?: unknown }).text === "string"
              ? String((v as { text: string }).text)
              : String(v).trim();
      if (text.length > 0) {
        data[h.field] = text;
        hasAny = true;
      }
    }
    if (!hasAny) continue;
    const parsed = parseImportRow({ rowNumber: r, raw: data, smartDetect });
    if (parsed.ok) {
      rowResults.push({
        rowNumber: parsed.rowNumber,
        ok: true,
        counts: {
          activities: parsed.activities.length,
          opportunities: parsed.opportunities.length,
          warnings: parsed.warnings.length,
          subjectSet: parsed.leadPatch.subject ? 1 : 0,
        },
      });
    } else {
      rowResults.push(parsed);
    }
  }

  console.log(`File: ${filePath}`);
  console.log(`Smart-detect: ${smartDetect ? "ON" : "OFF"}`);
  console.log(`Rows parsed: ${rowResults.length}`);
  let totalActivities = 0;
  let totalOpportunities = 0;
  let totalSubjects = 0;
  let totalWarnings = 0;
  let okCount = 0;
  let failCount = 0;
  const kindCounts: Record<string, number> = { call: 0, meeting: 0, note: 0, email: 0 };
  for (const r of rowResults) {
    if (r.ok) {
      okCount += 1;
      totalActivities += r.counts.activities;
      totalOpportunities += r.counts.opportunities;
      totalSubjects += r.counts.subjectSet;
      totalWarnings += r.counts.warnings;
    } else {
      failCount += 1;
    }
  }
  console.log(`OK rows: ${okCount}`);
  console.log(`Failed rows: ${failCount}`);
  console.log(`Total activities: ${totalActivities}`);
  console.log(`Total opportunities: ${totalOpportunities}`);
  console.log(`Subjects to set: ${totalSubjects}`);
  console.log(`Warnings: ${totalWarnings}`);
  console.log("\n--- per-row detail ---");
  for (const r of rowResults) {
    if (r.ok) {
      console.log(
        `Row ${r.rowNumber}: OK · activities=${r.counts.activities} opps=${r.counts.opportunities} subject=${r.counts.subjectSet ? "yes" : "no"} warnings=${r.counts.warnings}`,
      );
    } else {
      console.log(`Row ${r.rowNumber}: FAILED · ${r.errors.join(" | ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
