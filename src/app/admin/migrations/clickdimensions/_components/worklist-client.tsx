// consistency-exempt: list-page-pattern: admin-utility-table —
// raw 8-column worklist table inside overflow-x-auto, no StandardListPage
// renderCard mobile branch. Rows arrive pre-serialized from the server as
// a bounded, non-paginated prop (not a fetchPage cursor source), and the
// per-row controls (View HTML / Re-extract / Skip + selection checkbox)
// are an operational action grid, not a browsable record list. Admin-only
// internal migration tool — no saved views, no realtime, no infinite
// scroll. Matches the remap-list-client admin-utility-table carveout.
"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Pill } from "@/components/ui/pill";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { DEFAULT_TIME_PREFS, type TimePrefs } from "@/lib/format-time";
import {
  bulkFlagForReextractionAction,
  bulkSkipAction,
  flagForReextractionAction,
  skipMigrationAction,
} from "../actions";
import { ViewHtmlDialog } from "./view-html-dialog";

/**
 * ClickDimensions migration worklist (client island).
 *
 * Server passes pre-serialized rows. The client manages selection
 * state for bulk actions, dispatches server actions, and renders
 * the per-row action menu inline.
 */

export interface WorklistRow {
  id: string;
  cdTemplateId: string;
  cdTemplateName: string;
  cdSubject: string | null;
  cdCategory: string | null;
  editorType:
    | "custom-html"
    | "free-style"
    | "email-designer"
    | "drag-and-drop"
    | "unknown";
  status: "pending" | "extracted" | "imported" | "failed" | "skipped";
  attempts: number;
  extractedAt: string | null;
  lastAttemptAt: string | null;
  importedTemplateId: string | null;
  errorReason: string | null;
  hasHtml: boolean;
  htmlBytes: number;
}

const STATUS_CLASS: Record<WorklistRow["status"], string> = {
  pending:
    "bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
  extracted:
    "bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
  imported: "bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
  failed: "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
  skipped:
    "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]",
};

const STATUS_LABEL: Record<WorklistRow["status"], string> = {
  pending: "Pending",
  extracted: "Extracted",
  imported: "Imported",
  failed: "Failed",
  skipped: "Skipped",
};

const EDITOR_LABEL: Record<WorklistRow["editorType"], string> = {
  "custom-html": "Custom HTML",
  "free-style": "Free style",
  "email-designer": "Email designer",
  "drag-and-drop": "Drag and drop",
  unknown: "Unknown",
};

export function ClickDimensionsWorklistClient({
  rows,
  timePrefs = DEFAULT_TIME_PREFS,
}: {
  rows: WorklistRow[];
  timePrefs?: TimePrefs;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<WorklistRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<"all" | WorklistRow["status"]>("all");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const allVisibleSelected =
    visibleRows.length > 0 &&
    visibleRows.every((r) => selected.has(r.id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of visibleRows) next.delete(r.id);
      } else {
        for (const r of visibleRows) next.add(r.id);
      }
      return next;
    });
  }

  async function runRowAction(
    action: (fd: FormData) => Promise<{ ok: true } | { ok: false; error: string }>,
    id: string,
  ) {
    setErrorMessage(null);
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setErrorMessage(res.error);
      }
    });
  }

  async function runBulkAction(
    action: (fd: FormData) => Promise<{ ok: true } | { ok: false; error: string }>,
  ) {
    if (selected.size === 0) return;
    setErrorMessage(null);
    const fd = new FormData();
    for (const id of selected) fd.append("ids", id);
    startTransition(async () => {
      const res = await action(fd);
      if (res.ok) {
        setSelected(new Set());
      } else {
        setErrorMessage(res.error);
      }
    });
  }

  const statusCounts = useMemo(() => {
    const out: Record<WorklistRow["status"] | "all", number> = {
      all: rows.length,
      pending: 0,
      extracted: 0,
      imported: 0,
      failed: 0,
      skipped: 0,
    };
    for (const r of rows) out[r.status] += 1;
    return out;
  }, [rows]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            "all",
            "pending",
            "extracted",
            "imported",
            "failed",
            "skipped",
          ] as const
        ).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={[
              "rounded-full px-3 py-1 text-xs font-medium transition",
              filter === s
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            ].join(" ")}
          >
            {s === "all"
              ? `All (${statusCounts.all})`
              : `${STATUS_LABEL[s]} (${statusCounts[s]})`}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `${selected.size} selected`
              : `${visibleRows.length} ${visibleRows.length === 1 ? "row" : "rows"}`}
          </span>
          <button
            type="button"
            disabled={selected.size === 0 || isPending}
            onClick={() => runBulkAction(bulkFlagForReextractionAction)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Flag for re-extraction
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || isPending}
            onClick={() => runBulkAction(bulkSkipAction)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mark as skipped
          </button>
        </div>
      </div>

      {errorMessage ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                />
              </th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Editor</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Attempts</th>
              <th className="px-3 py-2">Imported as</th>
              <th className="px-3 py-2">Extracted at</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-border last:border-b-0 hover:bg-muted/20"
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.cdTemplateName}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggleRow(r.id)}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">
                    {r.cdTemplateName}
                  </div>
                  {r.cdSubject ? (
                    <div className="text-xs text-muted-foreground">
                      {r.cdSubject}
                    </div>
                  ) : null}
                  {r.errorReason ? (
                    <div className="text-xs text-destructive">
                      {r.errorReason}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {EDITOR_LABEL[r.editorType]}
                </td>
                <td className="px-3 py-2">
                  <Pill variant={STATUS_CLASS[r.status]}>
                    {STATUS_LABEL[r.status]}
                  </Pill>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.attempts}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.importedTemplateId ? (
                    <Link
                      href={`/marketing/templates/${r.importedTemplateId}`}
                      className="text-foreground underline-offset-4 hover:underline"
                    >
                      Open template
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.extractedAt ? (
                    <UserTimeClient value={r.extractedAt} prefs={timePrefs} />
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      disabled={!r.hasHtml}
                      onClick={() => setViewing(r)}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      View HTML
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() =>
                        runRowAction(flagForReextractionAction, r.id)
                      }
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Re-extract
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => runRowAction(skipMigrationAction, r.id)}
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Skip
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ViewHtmlDialog
        row={viewing}
        onClose={() => setViewing(null)}
      />
    </>
  );
}
