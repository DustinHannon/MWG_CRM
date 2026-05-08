"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/delete";

/**
 * Phase 11 — owner-only action row for the report runner page.
 *
 * Surface buttons:
 *   - Edit (link to /reports/[id]/edit)
 *   - Duplicate (POST /api/reports with same definition, then route)
 *   - Share toggle (PATCH isShared)
 *   - Delete (soft delete via DELETE)
 *
 * The Export PDF / CSV buttons live inside <ReportRunner>; this row
 * is only the owner controls.
 */
export interface ReportActionMenuProps {
  reportId: string;
  reportName: string;
  isShared: boolean;
  isBuiltin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Definition payload used to clone via Duplicate. */
  definition: {
    name: string;
    description: string | null;
    entityType: string;
    fields: string[];
    filters: Record<string, unknown>;
    groupBy: string[];
    metrics: unknown[];
    visualization: string;
  };
}

export function ReportActionMenu({
  reportId,
  reportName,
  isShared,
  isBuiltin,
  canEdit,
  canDelete,
  definition,
}: ReportActionMenuProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!canEdit && !canDelete) return null;

  async function duplicate() {
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...definition,
        name: `${definition.name} (copy)`,
        isShared: false,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error ?? "Could not duplicate report.");
      return;
    }
    toast.success("Report duplicated.");
    startTransition(() => {
      router.push(`/reports/${json.data.id}`);
    });
  }

  async function toggleShare() {
    const res = await fetch(`/api/reports/${reportId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isShared: !isShared }),
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error ?? "Could not update share state.");
      return;
    }
    toast.success(!isShared ? "Shared with team." : "Unshared.");
    startTransition(() => router.refresh());
  }

  async function softDelete(reason: string | undefined) {
    const res = await fetch(`/api/reports/${reportId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error ?? "Delete failed.");
      return;
    }
    toast.success("Report archived.");
    startTransition(() => router.push("/reports"));
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {canEdit && !isBuiltin ? (
        <Link
          href={`/reports/${reportId}/edit`}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted"
        >
          Edit
        </Link>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={duplicate}
        className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-60"
      >
        Duplicate
      </button>
      {canEdit && !isBuiltin ? (
        <button
          type="button"
          disabled={pending}
          onClick={toggleShare}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-60"
        >
          {isShared ? "Unshare" : "Share with team"}
        </button>
      ) : null}
      {canDelete && !isBuiltin ? (
        <ConfirmDeleteDialog
          entityKind="lead"
          entityName={reportName}
          extraBody={
            <p>
              This report will be archived. You can recreate it from the
              builder anytime.
            </p>
          }
          onConfirm={softDelete}
          trigger={
            <button
              type="button"
              className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-sm text-[var(--status-lost-fg)] transition hover:bg-destructive/25"
            >
              Delete
            </button>
          }
        />
      ) : null}
    </div>
  );
}
