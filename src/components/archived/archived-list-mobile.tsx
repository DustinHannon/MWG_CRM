import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";

/**
 * uniform dense mobile list for the five archived views
 * (leads, accounts, contacts, opportunities, tasks). Renders only at
 * <md (caller wraps it in `md:hidden`); the desktop archived table
 * stays as the >=md layout.
 *
 * Each archived entity has the same shape on this view:
 * • the entity's display name / title (with a deterministic-color
 * initials avatar so users can scan visually)
 * • a sub-line: optional secondary identifier (company / industry /
 * stage / account) · "Archived M/D" · "by <name>" · reason
 * • trailing actions injected by the caller — typically Restore +
 * Permanent-delete forms. The caller controls the action JSX so
 * each entity can keep its own inline server actions intact.
 */

export interface ArchivedListMobileRow {
  id: string;
  /** Primary display label (lead/contact full name, account / opp name, task title). */
  title: string;
  /** Optional secondary identifier — company / industry / stage / etc. */
  subtitle?: string | null;
  deletedAt: Date | string | null;
  deletedByName?: string | null;
  deletedByEmail?: string | null;
  reason?: string | null;
}

interface Props {
  rows: ArchivedListMobileRow[];
  /**
   * Render the per-row action buttons (Restore + Permanent-delete).
   * Caller owns the action JSX so the existing server-action `<form>`
   * fragments don't need to be refactored.
   */
  renderActions: (row: ArchivedListMobileRow) => ReactNode;
  /** Empty-state message. */
  emptyMessage?: ReactNode;
}

function shortDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const ts = new Date(d).getTime();
  if (Number.isNaN(ts)) return null;
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function ArchivedListMobile({
  rows,
  renderActions,
  emptyMessage,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "Nothing archived."}
      </div>
    );
  }
  return (
    <ul
      role="list"
      className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl"
    >
      {rows.map((r) => {
        const meta: string[] = [];
        if (r.subtitle) meta.push(r.subtitle);
        const archived = shortDate(r.deletedAt);
        if (archived) meta.push(`Archived ${archived}`);
        const by = r.deletedByName ?? r.deletedByEmail;
        if (by) meta.push(`by ${by}`);
        if (r.reason) meta.push(r.reason);
        return (
          <li key={r.id} className="px-3 py-3">
            <div className="flex items-start gap-3">
              <Avatar
                src={null}
                name={r.title}
                id={r.id}
                size={36}
                className="mt-0.5 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {r.title}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  {meta.length === 0 ? (
                    <span className="text-muted-foreground/60">No detail</span>
                  ) : (
                    meta.map((m, i) => (
                      <span key={i}>
                        {i > 0 ? (
                          <span
                            aria-hidden
                            className="mr-1.5 text-muted-foreground/50"
                          >
                            ·
                          </span>
                        ) : null}
                        <span className="break-words">{m}</span>
                      </span>
                    ))
                  )}
                </div>
                {/* Action row: caller-supplied buttons / forms. Wraps so
                    Restore + Delete sit on one line at most widths and
                    stack cleanly on the narrowest 380 px viewport. */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {renderActions(r)}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
