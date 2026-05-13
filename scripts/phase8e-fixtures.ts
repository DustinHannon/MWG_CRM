// Import edge-case fixture generator — produces targeted XLSX files
// that exercise rare parser paths the production smoke workbook
// doesn't cover.
// Usage: pnpm dlx tsx scripts/phase8e-fixtures.ts

import ExcelJS from "exceljs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { TEMPLATE_HEADERS } from "../src/lib/import/headers";

const HEADERS = TEMPLATE_HEADERS.map((h) =>
  h.required ? `${h.header}*` : h.header,
);

interface Row { [field: string]: string }

const outDir = path.join(process.cwd(), "test-data");

async function buildXlsx(filename: string, rows: Row[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Leads");
  sheet.addRow(HEADERS);
  for (const r of rows) {
    sheet.addRow(TEMPLATE_HEADERS.map((h) => r[h.field] ?? ""));
  }
  for (let i = 2; i <= sheet.rowCount; i++) {
    sheet.getRow(i).alignment = { wrapText: true, vertical: "top" };
  }
  await mkdir(outDir, { recursive: true });
  const out = path.join(outDir, filename);
  const buf = await wb.xlsx.writeBuffer();
  await writeFile(out, Buffer.from(buf));
  return out;
}

async function main(): Promise<void> {
  // 1. Empty workbook (header only).
  const empty = await buildXlsx("phase8e-empty.xlsx", []);
  console.log("Wrote", empty);

  // 2. Formula injection in firstName field.
  const formula = await buildXlsx("phase8e-formula-injection.xlsx", [
    {
      firstName: "=SUM(1+1)",
      lastName: "Injection",
      email: "formula@test.invalid",
      externalId: "PHASE8E-FORMULA-001",
    },
    {
      firstName: "+CMD|'/c calc.exe'!A1",
      lastName: "Injection2",
      email: "formula2@test.invalid",
      externalId: "PHASE8E-FORMULA-002",
    },
    {
      firstName: "@SUM(A1)",
      lastName: "Injection3",
      email: "formula3@test.invalid",
      externalId: "PHASE8E-FORMULA-003",
    },
  ]);
  console.log("Wrote", formula);

  // 3. Unicode names.
  const unicode = await buildXlsx("phase8e-unicode.xlsx", [
    { firstName: "Иван", lastName: "Петров", email: "ru@test.invalid", externalId: "PHASE8E-UNI-RU" },
    { firstName: "测试", lastName: "用户", email: "cn@test.invalid", externalId: "PHASE8E-UNI-CN" },
    { firstName: "محمد", lastName: "أحمد", email: "ar@test.invalid", externalId: "PHASE8E-UNI-AR" },
  ]);
  console.log("Wrote", unicode);

  // 4. Length boundary on firstName (99/100/101).
  const longName = await buildXlsx("phase8e-long-name.xlsx", [
    { firstName: "A".repeat(99), email: "n99@test.invalid", externalId: "PHASE8E-LEN-99" },
    { firstName: "A".repeat(100), email: "n100@test.invalid", externalId: "PHASE8E-LEN-100" },
    { firstName: "A".repeat(101), email: "n101@test.invalid", externalId: "PHASE8E-LEN-101" },
  ]);
  console.log("Wrote", longName);

  // 5. All rows invalid (no firstName, no email).
  const allInvalid = await buildXlsx("phase8e-all-invalid.xlsx", [
    { lastName: "Orphan1" },
    { lastName: "Orphan2" },
    { lastName: "Orphan3" },
  ]);
  console.log("Wrote", allInvalid);

  // 6. Mixed valid + invalid.
  const mixed = await buildXlsx("phase8e-mixed.xlsx", [
    { firstName: "Valid", lastName: "One", email: "v1@test.invalid", externalId: "PHASE8E-MIX-1" },
    { lastName: "OrphanRow" }, // invalid: no firstName, no email
    { firstName: "Valid", lastName: "Two", email: "v2@test.invalid", externalId: "PHASE8E-MIX-2" },
    { firstName: "BadEmail", email: "not-an-email", externalId: "PHASE8E-MIX-3" }, // invalid: bad email
  ]);
  console.log("Wrote", mixed);

  // 7. Tag length boundary — 50 char tag and 51 char tag.
  const tags = await buildXlsx("phase8e-tags.xlsx", [
    { firstName: "Tag", lastName: "Fifty", email: "tag50@test.invalid", tags: "T".repeat(50), externalId: "PHASE8E-TAG-50" },
    { firstName: "Tag", lastName: "FiftyOne", email: "tag51@test.invalid", tags: "T".repeat(51), externalId: "PHASE8E-TAG-51" },
    { firstName: "Tag", lastName: "Autocreate", email: "tagac@test.invalid", tags: "Phase8eTestTag", externalId: "PHASE8E-TAG-AC" },
  ]);
  console.log("Wrote", tags);

  // 8. Malformed D365 description (corrupted bracket timestamp).
  const malformedD365 = await buildXlsx("phase8e-malformed-d365.xlsx", [
    {
      firstName: "Mal",
      lastName: "Formed",
      email: "mal@test.invalid",
      externalId: "PHASE8E-MAL-001",
      description: `Topic: Test
Phone Calls:
[XXXX-99-99 99:99 ZZ ZZZ] Bad timestamp
  Outgoing | Duration: oops min | By: Nobody
  body line 1
[2024-01-01 02:00 PM UTC Missing close-bracket
  more body`,
    },
  ]);
  console.log("Wrote", malformedD365);

  // 9. CSV renamed to .xlsx.
  const csvBuf = Buffer.from("firstName,lastName,email\nFake,CSV,fake@csv.invalid\n", "utf8");
  const csvFake = path.join(outDir, "phase8e-csv-fake.xlsx");
  await writeFile(csvFake, csvBuf);
  console.log("Wrote", csvFake);

  // 10. DOCX magic-byte (it's a fake .docx that's actually a non-zip text).
  const docxBuf = Buffer.from("This is not a real docx — actually plain text disguised as .xlsx.\n", "utf8");
  const docxFake = path.join(outDir, "phase8e-docx-fake.xlsx");
  await writeFile(docxFake, docxBuf);
  console.log("Wrote", docxFake);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
