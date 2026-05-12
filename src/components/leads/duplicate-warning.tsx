"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
// import the client primitive directly (not the barrel) so
// the bundler doesn't pull UserHoverCard's server-only deps into the
// client graph.
import { UserChip } from "@/components/user-display/user-chip";

interface DuplicateMatch {
  id: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
}

interface DuplicateWarningProps {
  email: string;
  phone: string;
}

/**
 * debounced duplicate-check on lead create. Watches email +
 * phone fields; when either has ≥3 chars, hits /api/leads/check-duplicate
 * and renders an inline warning with matching leads.
 *
 * Render this BELOW the email/phone fields on the lead create form. It
 * does not block submit — the user can "Create anyway", which simply
 * means they ignore the warning. (The audit trail is via the lead.create
 * action.)
 */
export function DuplicateWarning({ email, phone }: DuplicateWarningProps) {
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const [expanded, setExpanded] = useState(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }

    const trimmedEmail = email.trim();
    const trimmedPhone = phone.replace(/\D/g, "");

    // Need at least one field with enough characters.
    if (trimmedEmail.length < 3 && trimmedPhone.length < 3) {
      // Defer the state clear out of the effect body to satisfy lint.
      debounceRef.current = window.setTimeout(() => setMatches([]), 0);
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (trimmedEmail.length >= 3) params.set("email", trimmedEmail);
        if (trimmedPhone.length >= 3) params.set("phone", trimmedPhone);
        const res = await fetch(
          `/api/leads/check-duplicate?${params.toString()}`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          setMatches([]);
          return;
        }
        const data = (await res.json()) as { matches: DuplicateMatch[] };
        setMatches(data.matches);
      } catch {
        setMatches([]);
      }
    }, 400);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [email, phone]);

  if (matches.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-[var(--priority-medium-fg)]/40 bg-[var(--priority-medium-bg)] p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle
          size={16}
          aria-hidden
          className="mt-0.5 shrink-0 text-[var(--priority-medium-fg)]"
        />
        <div className="flex-1">
          <p className="font-medium text-[var(--priority-medium-fg)]">
            {matches.length} existing lead{matches.length === 1 ? "" : "s"}{" "}
            match this email or phone.
          </p>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-xs text-[var(--priority-medium-fg)] underline-offset-2 hover:underline"
          >
            {expanded ? "Hide matches" : "View matches"}
          </button>

          {expanded ? (
            <ul className="mt-2 space-y-1.5">
              {matches.map((m) => (
                <li
                  key={m.id}
                  className="rounded border border-[var(--priority-medium-fg)]/20 bg-[var(--priority-medium-bg)]/40 p-2 text-xs"
                >
                  <Link
                    href={`/leads/${m.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-[var(--priority-medium-fg)] hover:underline"
                  >
                    {m.name}
                  </Link>
                  {m.companyName ? (
                    <span className="text-[var(--priority-medium-fg)]/80">
                      {" "}
                      · {m.companyName}
                    </span>
                  ) : null}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--priority-medium-fg)]/70">
                    {m.email ? <span>{m.email} ·</span> : null}
                    <span>{m.status}</span>
                    <span>· owner</span>
                    {/* canonical UserChip in lieu of plain
                        owner name. Hover card omitted: this surface
                        renders inline during typing. */}
                    {m.ownerId ? (
                      <UserChip
                        size="xs"
                        user={{
                          id: m.ownerId,
                          displayName: m.ownerName,
                          photoUrl: null,
                        }}
                      />
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-2 text-[11px] text-[var(--priority-medium-fg)]/80">
            You can use one of these existing leads, or continue to create a
            new one.
          </p>
        </div>
      </div>
    </div>
  );
}
