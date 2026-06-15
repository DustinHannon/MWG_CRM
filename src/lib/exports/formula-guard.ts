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

/**
 * Matches a string that is a plain signed/unsigned numeric literal
 * (e.g. "-1000.00", "+3.5", "42"). postgres-js returns numeric/decimal
 * columns (money amounts, revenue) as JS STRINGS with no `>= 0`
 * constraint, so a legitimate negative value arrives as "-1000.00" and
 * collides with the `-` formula-lead char. Such values are data, not
 * formulas, and must NOT be apostrophe-prefixed or the exported cell
 * becomes text and breaks downstream sums/parsing.
 */
const NUMERIC_LITERAL = /^[-+]?\d/;

export function neutralizeSpreadsheetFormula<T>(value: T): T | string {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!FORMULA_LEAD.test(value)) return value;
  // A genuine numeric value (e.g. "-1000.00") is not a formula — leaving
  // it untouched preserves negative money amounts in CSV/XLSX exports.
  if (NUMERIC_LITERAL.test(value) && Number.isFinite(Number(value))) {
    return value;
  }
  return `'${value}`;
}
