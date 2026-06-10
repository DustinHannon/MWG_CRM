import "server-only";
import ExcelJS from "exceljs";
import { neutralizeSpreadsheetFormula } from "@/lib/exports/formula-guard";

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

export async function buildErrorReport(
  errors: ImportError[],
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Errors");
  sheet.addRow(["Row", "Field", "Error"]);
  // field/message can echo uploaded cell content — guard the sink
  // (sibling of buildLeadsExport above).
  for (const e of errors)
    sheet.addRow([
      String(e.row),
      neutralizeSpreadsheetFormula(e.field),
      neutralizeSpreadsheetFormula(e.message),
    ]);
  sheet.columns = [{ width: 8 }, { width: 24 }, { width: 60 }];
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

export async function buildLeadsExport(
  rows: Array<Record<string, unknown>>,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Leads");
  if (rows.length === 0) {
    const buf = await wb.xlsx.writeBuffer();
    return new Uint8Array(buf as ArrayBuffer);
  }
  // Header order is the union of all row keys, preserving first-seen
  // order across rows so columns are stable across exports.
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        headers.push(k);
      }
    }
  }
  sheet.addRow(headers);
  for (const r of rows) {
    // Names/companies are permissive free text (nameField); neutralize
    // formula-injection at the sink so a value like `=cmd|...` exported
    // here can't execute when the .xlsx is opened.
    sheet.addRow(
      headers.map((h) => neutralizeSpreadsheetFormula(r[h] ?? "")),
    );
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
