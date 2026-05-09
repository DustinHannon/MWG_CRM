import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";

/**
 * Phase 12 — dense single-line mobile list for /contacts (and the
 * archived view). Mirrors `<LeadListMobile>` and `<AccountListMobile>`.
 */
export interface ContactListMobileRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  accountName: string | null;
}

function fullName(r: ContactListMobileRow): string {
  const parts = [r.firstName?.trim(), r.lastName?.trim()].filter(
    (s): s is string => !!s && s.length > 0,
  );
  if (parts.length > 0) return parts.join(" ");
  if (r.email?.trim()) return r.email.trim();
  return "(Unnamed contact)";
}

export function ContactListMobile({
  rows,
  emptyMessage,
}: {
  rows: ContactListMobileRow[];
  emptyMessage?: React.ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "No contacts."}
      </div>
    );
  }
  return (
    <ul
      role="list"
      className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl"
    >
      {rows.map((r) => {
        const name = fullName(r);
        const meta: string[] = [];
        if (r.jobTitle) meta.push(r.jobTitle);
        if (r.accountName) meta.push(r.accountName);
        else if (r.email) meta.push(r.email);
        return (
          <li key={r.id}>
            <Link
              href={`/contacts/${r.id}`}
              prefetch={false}
              className="flex items-center gap-3 px-3 py-3 transition active:bg-muted"
            >
              <Avatar
                src={null}
                name={name}
                id={r.id}
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
                      No company · no title
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
