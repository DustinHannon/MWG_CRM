import "server-only";

import ExcelJS from "exceljs";
import { z } from "zod";

/**
 * Phase 29 §6 — Static-list Excel import parser.
 *
 * Reads a 2-column workbook (`email` required, `name` optional),
 * validates each row, and returns a structured payload that the
 * commit step inserts into `marketing_static_list_members`.
 *
 * Header detection is case-insensitive and supports a small alias set
 * so users who export from Outlook / D365 / SendGrid don't have to
 * rename columns.
 */

const EMAIL_ALIASES = new Set(
  [
    "email",
    "email address",
    "email_address",
    "e-mail",
    "e-mail address",
    "emailaddress",
    "primary email",
    "work email",
    "recipient",
  ].map((s) => s.toLowerCase()),
);

const NAME_ALIASES = new Set(
  [
    "name",
    "full name",
    "full_name",
    "fullname",
    "display name",
    "display_name",
    "displayname",
    "contact",
    "contact name",
    "recipient name",
  ].map((s) => s.toLowerCase()),
);

/**
 * Per-row import status:
 *   • `ok`        — passes validation; inserted at commit time.
 *   • `invalid`   — bad email or other validation failure; skipped at
 *                   commit time (already counted in `failedRows`).
 *   • `duplicate` — collides with another row in this file OR with an
 *                   existing list member; skipped at commit time.
 */
export type StaticImportRowStatus = "ok" | "invalid" | "duplicate";

export interface StaticImportRow {
  /** 1-based row number from the workbook (header is row 1). */
  row: number;
  email: string;
  name: string | null;
  status: StaticImportRowStatus;
  /** Why a row is `invalid` or `duplicate`. Null when `ok`. */
  reason: string | null;
}

export interface StaticImportError {
  row: number;
  field: "email" | "name" | null;
  code:
    | "MISSING_EMAIL"
    | "INVALID_EMAIL"
    | "DUPLICATE_IN_FILE"
    | "DUPLICATE_IN_LIST"
    | "ROW_TOO_LONG"
    | "MISSING_REQUIRED_HEADER";
  message: string;
}

export interface ColumnDetect {
  emailColumn: number | null;
  nameColumn: number | null;
  /** True when both columns were found and email looks unambiguous. */
  confident: boolean;
  /** Headers we ignored. */
  unknownHeaders: string[];
}

export interface ParseStaticListWorkbookResult {
  rows: StaticImportRow[];
  errors: StaticImportError[];
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  duplicateRows: number;
  detect: ColumnDetect;
}

const MAX_ROWS = 50_000;

interface ParseArgs {
  buffer: ArrayBuffer;
  /** Existing list emails (already lowercased) used for cross-list dedup. */
  existingEmails: Set<string>;
}

const emailSchema = z.string().trim().email();

export async function parseStaticListWorkbook({
  buffer,
  existingEmails,
}: ParseArgs): Promise<ParseStaticListWorkbookResult> {
  const wb = new ExcelJS.Workbook();
  // exceljs's load() typing wants Uint8Array on Node 24.
  // @ts-expect-error -- ExcelJS Buffer typing mismatch with Node 24
  await wb.xlsx.load(new Uint8Array(buffer));

  const sheet = wb.worksheets[0];
  if (!sheet) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          field: null,
          code: "MISSING_REQUIRED_HEADER",
          message: "Workbook contains no sheets.",
        },
      ],
      totalRows: 0,
      successfulRows: 0,
      failedRows: 0,
      duplicateRows: 0,
      detect: {
        emailColumn: null,
        nameColumn: null,
        confident: false,
        unknownHeaders: [],
      },
    };
  }

  const headerRow = sheet.getRow(1);
  let emailColumn: number | null = null;
  let nameColumn: number | null = null;
  const unknownHeaders: string[] = [];

  const columnCount = Math.max(sheet.columnCount, 2);
  for (let c = 1; c <= columnCount; c++) {
    const raw = headerRow.getCell(c).value;
    const label = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (!label) continue;
    if (emailColumn === null && EMAIL_ALIASES.has(label)) {
      emailColumn = c;
      continue;
    }
    if (nameColumn === null && NAME_ALIASES.has(label)) {
      nameColumn = c;
      continue;
    }
    unknownHeaders.push(String(raw ?? ""));
  }

  if (emailColumn === null) {
    return {
      rows: [],
      errors: [
        {
          row: 1,
          field: "email",
          code: "MISSING_REQUIRED_HEADER",
          message:
            "Could not find an email column. Add a header like 'email' or 'Email Address'.",
        },
      ],
      totalRows: 0,
      successfulRows: 0,
      failedRows: 0,
      duplicateRows: 0,
      detect: {
        emailColumn: null,
        nameColumn: null,
        confident: false,
        unknownHeaders,
      },
    };
  }

  const rows: StaticImportRow[] = [];
  const errors: StaticImportError[] = [];
  const seenInFile = new Set<string>();
  const lastRow = Math.min(sheet.rowCount, MAX_ROWS + 1);

  for (let r = 2; r <= lastRow; r++) {
    const rowObj = sheet.getRow(r);
    if (rowObj.cellCount === 0) continue;
    const rawEmail = readCellAsString(rowObj.getCell(emailColumn).value);
    const rawName =
      nameColumn !== null
        ? readCellAsString(rowObj.getCell(nameColumn).value)
        : null;

    // A row with no email and no name is treated as blank and skipped
    // silently (common at the end of a sheet).
    if (!rawEmail && !rawName) continue;

    if (!rawEmail) {
      errors.push({
        row: r,
        field: "email",
        code: "MISSING_EMAIL",
        message: "Email is required.",
      });
      rows.push({
        row: r,
        email: "",
        name: rawName,
        status: "invalid",
        reason: "Email is required.",
      });
      continue;
    }

    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) {
      errors.push({
        row: r,
        field: "email",
        code: "INVALID_EMAIL",
        message: `'${rawEmail}' is not a valid email.`,
      });
      rows.push({
        row: r,
        email: rawEmail,
        name: rawName,
        status: "invalid",
        reason: "Invalid email format.",
      });
      continue;
    }

    const normalized = parsed.data.toLowerCase();
    if (seenInFile.has(normalized)) {
      errors.push({
        row: r,
        field: "email",
        code: "DUPLICATE_IN_FILE",
        message: `'${normalized}' appears more than once in this file.`,
      });
      rows.push({
        row: r,
        email: normalized,
        name: rawName,
        status: "duplicate",
        reason: "Duplicate within file.",
      });
      continue;
    }
    seenInFile.add(normalized);

    if (existingEmails.has(normalized)) {
      errors.push({
        row: r,
        field: "email",
        code: "DUPLICATE_IN_LIST",
        message: `'${normalized}' is already in this list.`,
      });
      rows.push({
        row: r,
        email: normalized,
        name: rawName,
        status: "duplicate",
        reason: "Already in this list.",
      });
      continue;
    }

    rows.push({
      row: r,
      email: normalized,
      name: rawName,
      status: "ok",
      reason: null,
    });
  }

  const totalRows = rows.length;
  const successfulRows = rows.filter((r) => r.status === "ok").length;
  const failedRows = rows.filter((r) => r.status === "invalid").length;
  const duplicateRows = rows.filter((r) => r.status === "duplicate").length;

  return {
    rows,
    errors,
    totalRows,
    successfulRows,
    failedRows,
    duplicateRows,
    detect: {
      emailColumn,
      nameColumn,
      confident: emailColumn !== null && nameColumn !== null,
      unknownHeaders,
    },
  };
}

function readCellAsString(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  // ExcelJS hyperlink / rich-text shapes.
  if (typeof value === "object") {
    const v = value as { text?: unknown; result?: unknown; richText?: unknown };
    if (typeof v.text === "string") return v.text.trim() || null;
    if (typeof v.result === "string") return v.result.trim() || null;
    if (Array.isArray(v.richText)) {
      const joined = v.richText
        .map((seg) =>
          typeof seg === "object" && seg && typeof (seg as { text?: unknown }).text === "string"
            ? (seg as { text: string }).text
            : "",
        )
        .join("")
        .trim();
      return joined || null;
    }
  }
  return null;
}

/**
 * Generate a minimal .xlsx template with `email` and `name` header
 * columns and no data rows.
 */
export async function buildStaticListImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MWG CRM";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Recipients");
  sheet.columns = [
    { header: "email", key: "email", width: 36 },
    { header: "name", key: "name", width: 28 },
  ];
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
