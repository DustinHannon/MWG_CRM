// Shared X-axis / tooltip time-label formatter for the metrics charts.
// Bucket strings are ISO `YYYY-MM-DDTHH:MM:SSZ` (UTC). Parsing with
// `new Date(...)` and reading local hours/minutes gives every chart on
// the dashboard the same clock, so the axes can't disagree.
export function formatBucketTick(t: string): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}
