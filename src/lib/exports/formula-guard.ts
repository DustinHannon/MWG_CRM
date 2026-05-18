/**
 * Spreadsheet formula-injection neutralizer (OWASP "CSV Injection" /
 * "Formula Injection").
 *
 * Pure and isomorphic — server export routes AND client-side CSV-blob
 * downloads import this one canonical guard, so a new export surface
 * cannot silently reintroduce the hole.
 *
 * Person names and other free-text fields are deliberately NOT
 * character-class restricted on input (see `nameField` —
 * "letters only" rejects real names). The correct place to stop a
 * cell like `=HYPERLINK(...)` / `+cmd|...` / `@SUM(...)` from
 * executing when an exported file is opened in Excel / Sheets /
 * LibreOffice is the EXPORT SINK, not input validation. A leading
 * apostrophe forces the spreadsheet to treat the cell as literal
 * text.
 *
 * Apply this to every user-derived string written into a CSV/XLSX
 * cell. Non-strings (numbers, Dates, null) pass through untouched.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function neutralizeSpreadsheetFormula<T>(value: T): T | string {
  if (typeof value !== "string" || value.length === 0) return value;
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}
