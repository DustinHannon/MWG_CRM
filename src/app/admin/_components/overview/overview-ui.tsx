import type { ReactNode } from "react";

/**
 * Shared presentational shells for the admin overview widgets. Kept
 * here (consumed by ≥3 widgets) rather than duplicated per widget.
 * Server-safe — no client hooks. Semantic tokens only.
 */

export function OverviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Degraded state for a widget whose data source is slow or down. One
 * line, no detail leaked — the widget failing must never blank the
 * admin landing page.
 */
export function OverviewUnavailable({ note }: { note?: string }) {
  return (
    <div
      role="status"
      className="rounded-2xl border border-border bg-muted/40 p-5 text-sm text-muted-foreground"
    >
      {note ?? "Unavailable right now."}
    </div>
  );
}

/** Single metric tile — matches the existing overview Stat visual language. */
export function OverviewTile({
  label,
  value,
  attention = false,
  sub,
}: {
  label: string;
  value: string | number;
  attention?: boolean;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-5 backdrop-blur-xl">
      <p className="text-xs uppercase tracking-wide text-muted-foreground/80">
        {label}
      </p>
      <p
        className={`mt-3 text-3xl font-semibold tabular-nums ${
          attention ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </p>
      {sub ? (
        <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
      ) : null}
    </div>
  );
}
