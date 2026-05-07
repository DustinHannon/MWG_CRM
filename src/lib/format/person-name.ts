// Phase 6A — Lead/contact last_name became nullable. UI must render person
// names through this helper so that NULL last_name doesn't produce stray
// whitespace or break alignment.

export function formatPersonName(p: {
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const parts = [p.firstName, p.lastName].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (parts.length === 0) return "(Unnamed)";
  return parts.join(" ");
}

// Same shape but for snake_case rows (e.g., raw SQL execute_sql results).
export function formatPersonNameRow(p: {
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return formatPersonName({ firstName: p.first_name, lastName: p.last_name });
}
