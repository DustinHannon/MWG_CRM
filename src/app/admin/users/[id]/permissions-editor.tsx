"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { PermissionCategoryTable } from "@/components/admin/permission-category-table";
import { updateUserPermissions } from "./actions";
import type { PermissionKey } from "@/lib/auth-helpers";

interface PermissionsEditorProps {
  userId: string;
  initialPermissions: Record<PermissionKey, boolean>;
  /**
   * The breakglass account always holds every permission and is
   * reconciled to all-true on cold start (see lib/breakglass.ts). When
   * true the editor is read-only — the server action rejects the edit
   * anyway; this keeps the UI honest, matching the disabled admin /
   * active toggles for breakglass.
   */
  isBreakglass?: boolean;
}

/**
 * Atomic permission editor for the admin user-detail page. Holds a
 * local copy of the permission map; Save serializes the entire map to
 * the server action which writes the diff in one audit event.
 */
export function PermissionsEditor({
  userId,
  initialPermissions,
  isBreakglass = false,
}: PermissionsEditorProps) {
  const [perms, setPerms] =
    useState<Record<PermissionKey, boolean>>(initialPermissions);
  const [pending, startTransition] = useTransition();

  const dirty = (Object.keys(perms) as PermissionKey[]).some(
    (k) => perms[k] !== initialPermissions[k],
  );

  function handleChange(key: PermissionKey, value: boolean): void {
    setPerms((prev) => ({ ...prev, [key]: value }));
  }

  function handleReset(): void {
    setPerms(initialPermissions);
  }

  function handleSave(): void {
    startTransition(async () => {
      try {
        const result = await updateUserPermissions({
          userId,
          permissions: perms,
        });
        if (!result.ok) {
          toast.error(result.error ?? "Save failed.");
          return;
        }
        toast.success("Permissions saved.");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed.");
      }
    });
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Permissions
          </h2>
          <p className="mt-1 text-xs text-muted-foreground/80">
            Admins bypass these. Save commits every change atomically.
            {isBreakglass
              ? " Breakglass always holds every permission; these cannot be changed."
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || pending || isBreakglass}
            onClick={handleReset}
            className="inline-flex min-h-[44px] items-center rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            disabled={!dirty || pending || isBreakglass}
            onClick={handleSave}
            className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <PermissionCategoryTable
        values={perms}
        onChange={handleChange}
        disabled={pending || isBreakglass}
      />
    </section>
  );
}
