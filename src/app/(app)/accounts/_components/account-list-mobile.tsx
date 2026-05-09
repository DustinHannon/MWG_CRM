import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";

/**
 * Phase 12 — dense single-line mobile list for /accounts (and the
 * archived view). Renders only at <768 px; the desktop table layout
 * takes over at md+. Mirrors `<LeadListMobile>` so list pages feel
 * uniform on mobile.
 */
export interface AccountListMobileRow {
  id: string;
  name: string;
  industry: string | null;
  wonDeals?: number;
  createdAt: Date | string | null;
}

function relativeShort(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const ts = new Date(d).getTime();
  if (Number.isNaN(ts)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 45) return "just now";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function AccountListMobile({
  rows,
  emptyMessage,
}: {
  rows: AccountListMobileRow[];
  emptyMessage?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "No accounts."}
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
        if (r.industry) meta.push(r.industry);
        if (typeof r.wonDeals === "number" && r.wonDeals > 0) {
          meta.push(`${r.wonDeals} won`);
        }
        const rel = relativeShort(r.createdAt);
        if (rel) meta.push(rel);
        return (
          <li key={r.id}>
            <Link
              href={`/accounts/${r.id}`}
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
              <ChevronRight
                className="h-4 w-4 shrink-0 text-muted-foreground/60"
                aria-hidden
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
