// Canonical USD money formatter. Single source for every money render
// (CLAUDE.md §18: ≥3 call sites → extraction justified). DB numeric columns
// arrive as strings via postgres-js; this normalizes both string and number.
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a USD amount as `$1,234.56`. Returns the em-dash placeholder
 * for null/blank/non-numeric input (matches the platform `Field` convention).
 */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  // `Number("  ")` is 0, so a whitespace-only string would otherwise
  // render `$0.00`. Treat trimmed-empty as blank to match the contract.
  if (typeof value === "string" && value.trim() === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return USD.format(n);
}
