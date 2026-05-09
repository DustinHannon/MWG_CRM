import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { StatusPill } from "@/components/ui/status-pill";
import type { LeadRow } from "@/lib/views";

/**
 * Phase 12 — dense single-line mobile list for /leads (and the
 * archived view). Renders only at <768px; the desktop table layout
 * takes over above that.
 *
 * Pattern follows what every mainstream mobile CRM/inbox does at
 * scale — initials-avatar + name + status pill + sub-line of the
 * 1–2 most relevant meta fields (company · relative-time). The full
 * record is one tap away on `/leads/[id]`. ~80px per row vs. the
 * prior `data-table-cards` layout's ~200px so 100 leads fits in a
 * scrollable panel without exhausting the user.
 *
 * Avatar uses the LEAD's initials (not the owner's) — the default
 * "My Open Leads" view shows the user their own name 100 times if
 * we keyed off owner; the lead's own initials are distinctive and
 * help recognition.
 */
interface Props {
  rows: LeadRow[];
}

function fullName(l: LeadRow): string {
  const parts = [l.firstName?.trim(), l.lastName?.trim()].filter(
    (s): s is string => !!s && s.length > 0,
  );
  if (parts.length > 0) return parts.join(" ");
  if (l.companyName?.trim()) return l.companyName.trim();
  return "(Unnamed lead)";
}

/** Compact relative time — m / h / d / mo / y. */
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

export function LeadListMobile({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
        No leads match this view.
      </div>
    );
  }
  return (
    <ul
      role="list"
      className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl"
    >
      {rows.map((l) => {
        const name = fullName(l);
        const meta: string[] = [];
        if (l.companyName) meta.push(l.companyName);
        const rel = relativeShort(l.lastActivityAt ?? l.createdAt);
        if (rel) meta.push(rel);
        return (
          <li key={l.id}>
            <Link
              href={`/leads/${l.id}`}
              prefetch={false}
              className="flex items-center gap-3 px-3 py-3 transition active:bg-muted"
            >
              <Avatar
                src={null}
                name={name}
                id={l.id}
                size={36}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {name}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {meta.length === 0 ? (
                    <span className="text-muted-foreground/60">
                      No company · no activity
                    </span>
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
                <StatusPill status={l.status} className="text-[10px]" />
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
