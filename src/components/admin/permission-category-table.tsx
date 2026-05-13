"use client";

import { StandardCollapsibleSection } from "@/components/standard";
import type { PermissionKey } from "@/lib/auth-helpers";
import {
  PERMISSION_CATEGORIES,
  PERMISSION_LABELS,
} from "@/lib/permissions/ui-categories";

interface PermissionCategoryTableProps {
  values: Record<PermissionKey, boolean>;
  onChange: (key: PermissionKey, value: boolean) => void;
  disabled?: boolean;
}

/**
 * Collapsible category-grouped permission editor. Every key defined in
 * `PERMISSION_CATEGORIES` renders a toggle inside the appropriate
 * collapsible section. Changes are propagated up via `onChange`;
 * persistence is the parent's responsibility.
 */
export function PermissionCategoryTable({
  values,
  onChange,
  disabled,
}: PermissionCategoryTableProps) {
  return (
    <div className="flex flex-col gap-3">
      {PERMISSION_CATEGORIES.map((category) => {
        const granted = category.keys.filter((k) => values[k]).length;
        const total = category.keys.length;
        return (
          <StandardCollapsibleSection
            key={category.id}
            sectionKey={category.id}
            label={category.label}
            badge={`${granted} / ${total}`}
            defaultExpanded={false}
            storagePrefix="mwgcrm.admin.permissions.category."
            domIdPrefix="admin-perm-category-"
          >
            <div className="flex flex-col divide-y divide-border">
              {category.keys.map((key) => {
                const meta = PERMISSION_LABELS[key];
                return (
                  <div
                    key={key}
                    className="flex items-start justify-between gap-4 py-3"
                    data-permission={key}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {meta.label}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground/80">
                        {meta.hint}
                      </p>
                    </div>
                    <PermissionToggle
                      name={key}
                      checked={values[key]}
                      onChange={(v) => onChange(key, v)}
                      disabled={disabled}
                    />
                  </div>
                );
              })}
            </div>
          </StandardCollapsibleSection>
        );
      })}
    </div>
  );
}

function PermissionToggle({
  name,
  checked,
  onChange,
  disabled,
}: {
  name: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      name={name}
      aria-checked={checked}
      aria-label={PERMISSION_LABELS[name as PermissionKey].label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-[var(--status-won-fg)]" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
