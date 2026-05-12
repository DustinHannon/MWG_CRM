import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { StatusPill } from "@/components/ui/status-pill";

/**
 * dense single-line mobile list for /opportunities (and the
 * archived view). Mirrors the lead/account/contact mobile lists.
 *
 * Stage pill renders inline on the right edge — it's the most useful
 * at-a-glance indicator for opportunities (open vs. won vs. lost).
 */
export interface OpportunityListMobileRow {
  id: string;
  name: string;
  stage: string;
  amount: number | string | null;
  accountName: string | null;
  expectedCloseDate: Date | string | null;
}

function shortDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const ts = new Date(d).getTime();
  if (Number.isNaN(ts)) return null;
  // M/D format — concise for mobile.
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function shortAmount(a: number | string | null): string | null {
  if (a === null || a === undefined || a === "") return null;
  const n = typeof a === "number" ? a : Number(a);
  if (Number.isNaN(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function OpportunityListMobile({
  rows,
  emptyMessage,
}: {
  rows: OpportunityListMobileRow[];
  emptyMessage?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "No opportunities."}
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
        const amt = shortAmount(r.amount);
        if (amt) meta.push(amt);
        if (r.accountName) meta.push(r.accountName);
        const close = shortDate(r.expectedCloseDate);
        if (close) meta.push(`close ${close}`);
        return (
          <li key={r.id}>
            <Link
              href={`/opportunities/${r.id}`}
              prefetch={false}
              className="flex items-center gap-3 px-3 py-3 transition active:bg-muted"
            >
              <Avatar
                src={null}
                name={r.name}
                id={r.id}
                size={36}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {r.name}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {meta.length === 0 ? (
                    <span className="text-muted-foreground/60">No detail</span>
                  ) : (
                    meta.map((m, i) => (
                      <span key={i} className="truncate">
                        {i > 0 ? (
                          <span
                            aria-hidden
                            className="mx-1.5 text-muted-foreground/50"
                          >
                            ·
                          </span>
                        ) : null}
                        {m}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusPill status={r.stage} className="text-[10px]" />
                <ChevronRight
                  className="h-4 w-4 text-muted-foreground/60"
                  aria-hidden
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
