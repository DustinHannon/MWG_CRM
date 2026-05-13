"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { StandardConfirmDialog } from "@/components/standard";
import { applyRoleBundleAction } from "@/app/admin/users/[id]/actions";
import type { PermissionKey } from "@/lib/auth-helpers";
import {
  detectBundle,
  ROLE_BUNDLE_LABELS,
  ROLE_BUNDLES,
  type MarketingRoleBundle,
} from "@/lib/permissions/role-bundles";

const BUNDLE_NAMES = Object.keys(ROLE_BUNDLES) as MarketingRoleBundle[];

interface RoleBundleSelectorProps {
  userId: string;
  currentPermissions: Record<PermissionKey, boolean>;
}

/**
 * Marketing role bundle selector + apply control. Pre-selects the
 * bundle whose permission set exactly matches the user's current
 * marketing permissions, otherwise falls back to "Custom".
 *
 * Applying a bundle overwrites every marketing permission column.
 * Non-marketing permissions (canViewAllRecords, etc.) are unaffected.
 */
export function RoleBundleSelector({
  userId,
  currentPermissions,
}: RoleBundleSelectorProps) {
  const detected = useMemo(
    () => detectBundle(currentPermissions),
    [currentPermissions],
  );
  const [selected, setSelected] = useState<MarketingRoleBundle | "custom">(
    detected,
  );
  const [pending, startTransition] = useTransition();

  const canApply =
    selected !== "custom" &&
    !pending &&
    (detected === "custom" || selected !== detected);

  async function handleConfirm(): Promise<void> {
    if (selected === "custom") return;
    const bundle = selected;
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          const result = await applyRoleBundleAction({
            userId,
            bundleName: bundle,
          });
          if (!result.ok) {
            toast.error(result.error ?? "Failed to apply role bundle.");
          } else {
            toast.success(
              `Applied ${ROLE_BUNDLE_LABELS[bundle].split(" — ")[0]}.`,
            );
          }
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to apply.");
        } finally {
          resolve();
        }
      });
    });
  }

  return (
    <section
      className="rounded-2xl border border-border bg-muted/40 p-6"
      data-testid="role-bundle-selector"
    >
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Marketing role bundle
      </h2>
      <p className="mt-1 text-xs text-muted-foreground/80">
        Sets every marketing permission to the bundle preset. Non-marketing
        permissions stay as-is.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="Role bundle"
          value={selected}
          disabled={pending}
          onChange={(e) =>
            setSelected(e.target.value as MarketingRoleBundle | "custom")
          }
          className="min-h-[44px] min-w-[14rem] rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="custom">
            {detected === "custom"
              ? "Custom (no bundle match)"
              : "Custom — leave unchanged"}
          </option>
          {BUNDLE_NAMES.map((name) => (
            <option key={name} value={name}>
              {ROLE_BUNDLE_LABELS[name]}
            </option>
          ))}
        </select>
        <StandardConfirmDialog
          title="Apply role bundle?"
          body="This overwrites every marketing permission on this user. Non-marketing permissions stay as-is."
          confirmLabel="Apply"
          cancelLabel="Cancel"
          tone="primary"
          onConfirm={handleConfirm}
          trigger={
            <button
              type="button"
              disabled={!canApply}
              className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply bundle
            </button>
          }
        />
      </div>
    </section>
  );
}
