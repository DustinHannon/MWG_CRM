// workbook -> row[] driver. Loads an .xlsx buffer with
// exceljs, maps headers via headers.ts, hands each row to parseImportRow.
// Returns a flat list of ParsedResult; caller aggregates into a preview
// or hands directly to commit.

import "server-only";
import ExcelJS from "exceljs";
import { lookupHeader } from "./headers";
import { parseImportRow, type ParseResult } from "./parse-row";

export interface ParseWorkbookResult {
  totalRows: number;
  rows: ParseResult[];
  /** Headers we couldn't map. Each is a value the importer ignored. */
  unknownHeaders: string[];
  /** Required headers that were missing from the file. */
  missingRequiredHeaders: string[];
}

const MAX_ROWS = 10_000;

interface ParseWorkbookArgs {
  buffer: ArrayBuffer | Buffer;
  smartDetect: boolean;
}

export async function parseWorkbookBuffer({
  buffer,
  smartDetect,
}: ParseWorkbookArgs): Promise<ParseWorkbookResult> {
  const wb = new ExcelJS.Workbook();
  // exceljs's load() typing wants Uint8Array on Node 24.
  // @ts-expect-error -- ExcelJS Buffer typing mismatch with Node 24
  await wb.xlsx.load(new Uint8Array(buffer as ArrayBuffer));
  const sheet =
    wb.worksheets.find((s) => s.name.toLowerCase() === "leads") ??
    wb.worksheets[0];
  if (!sheet) {
    return {
      totalRows: 0,
      rows: [],
      unknownHeaders: [],
      missingRequiredHeaders: ["Leads sheet"],
    };
  }

  const headerRow = sheet.getRow(1);
  const headers: Array<{ raw: string; field: string | null }> = [];
  for (let c = 1; c <= sheet.columnCount; c++) {
    const v = headerRow.getCell(c).value;
    const raw = v == null ? "" : String(v).trim();
    if (raw.length === 0) {
      headers.push({ raw, field: null });
      continue;
    }
    const mapping = lookupHeader(raw);
    headers.push({ raw, field: mapping?.field ?? null });
  }

  const unknownHeaders = headers
    .filter((h) => h.raw.length > 0 && !h.field)
    .map((h) => h.raw);
  const missingRequiredHeaders: string[] = [];
  // Only firstName is structurally required at the column level —
  // every other field can be empty per row.
  if (!headers.some((h) => h.field === "firstName")) {
    missingRequiredHeaders.push("First Name");
  }

  const rows: ParseResult[] = [];
  const lastRow = Math.min(sheet.rowCount, MAX_ROWS + 1);
  for (let r = 2; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    if (!row || row.cellCount === 0) continue;
    const data: Record<string, string | undefined> = {};
    let hasAny = false;
    for (let c = 1; c <= headers.length; c++) {
      const header = headers[c - 1];
      if (!header.field) continue;
      const cellValue = row.getCell(c).value;
      const text = stringifyCell(cellValue);
      if (text.length > 0) {
        data[header.field] = text;
        hasAny = true;
      }
    }
    if (!hasAny) continue;
    rows.push(parseImportRow({ rowNumber: r, raw: data, smartDetect }));
  }

  return {
    totalRows: rows.length,
    rows,
    unknownHeaders,
    missingRequiredHeaders,
  };
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray((obj as { richText?: unknown }).richText)) {
      const richText = (obj as { richText: Array<{ text?: string }> }).richText;
      return richText.map((p) => p.text ?? "").join("");
    }
    if (typeof obj.formula === "string" && "result" in obj) {
      return stringifyCell((obj as { result: unknown }).result);
    }
    if (
      "hyperlink" in obj &&
      typeof (obj as { text?: unknown }).text === "string"
    ) {
      return String((obj as { text: string }).text);
    }
  }
  return String(v).trim();
}
