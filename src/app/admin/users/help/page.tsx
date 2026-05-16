import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardCollapsibleSection } from "@/components/standard";
import { GlassCard } from "@/components/ui/glass-card";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  PERMISSION_CATEGORIES,
  PERMISSION_DEFAULT_ON,
  PERMISSION_LABELS,
} from "@/lib/permissions/ui-categories";
import {
  ALL_MARKETING_KEYS,
  ROLE_BUNDLE_LABELS,
  ROLE_BUNDLES,
  type MarketingRoleBundle,
} from "@/lib/permissions/role-bundles";

export const dynamic = "force-dynamic";

/**
 * `/admin/users/help`. Admin-only reference page that documents every
 * permission flag's effect. Linked from the admin Users list header so
 * admins can answer "what does this toggle do?" without reading code.
 *
 * Data-driven from the same catalog the editor uses: categories and
 * copy come from `PERMISSION_CATEGORIES` / `PERMISSION_LABELS` in
 * `src/lib/permissions/ui-categories.ts`, default state from
 * `PERMISSION_DEFAULT_ON` (which mirrors the `permissions` table
 * defaults in `src/db/schema/users.ts`), and role bundles from
 * `src/lib/permissions/role-bundles.ts`. Adding a permission requires
 * only updating that catalog (slot it into a category, add a label,
 * and add it to `PERMISSION_DEFAULT_ON` if it defaults on) — no edit
 * to this file. The collapsible sections reuse the same
 * `StandardCollapsibleSection` as the editor so both surfaces look and
 * behave the same.
 */
const BUNDLE_NAMES = Object.keys(ROLE_BUNDLES) as MarketingRoleBundle[];

export default async function UsersHelpPage() {
  await requireAdmin();

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Users", href: "/admin/users" },
          { label: "Help" },
        ]}
      />
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/admin/users" className="hover:underline">
          Users
        </Link>
        <span aria-hidden>›</span>
        <span>Permission help</span>
      </div>
      <h1 className="text-2xl font-semibold">Permission help</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        What every permission on the user permissions card does. Admins
        bypass every permission below — toggling one on an admin has no
        effect because{" "}
        <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
          isAdmin
        </code>{" "}
        short-circuits each gate. Sections match the categories on the
        user&rsquo;s permissions editor.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Marketing role bundles
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground/80">
          On a user&rsquo;s detail page, applying a bundle overwrites
          every marketing permission and the two tag permissions (Apply
          tags, Manage tag library): each is set to match the preset, so
          anything not in the preset is turned off. Other permissions
          are left unchanged. Individual permissions can still be
          toggled afterward.
        </p>
        <GlassCard className="mt-3 overflow-hidden p-0">
          <table className="data-table min-w-full divide-y divide-border/60">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3 font-medium">Bundle</th>
                <th className="px-5 py-3 font-medium">What it grants</th>
                <th className="px-5 py-3 font-medium">Turned on</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 text-sm">
              {BUNDLE_NAMES.map((name) => {
                const [title, grants] =
                  ROLE_BUNDLE_LABELS[name].split(" — ");
                return (
                  <tr key={name} className="text-sm">
                    <td className="px-5 py-3 align-top">
                      <span className="font-medium text-foreground">
                        {title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {name}
                      </span>
                    </td>
                    <td className="px-5 py-3 align-top text-foreground/90">
                      {grants}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 align-top text-muted-foreground">
                      {ROLE_BUNDLES[name].length} of{" "}
                      {ALL_MARKETING_KEYS.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </GlassCard>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Permissions by category
        </h2>
        <p className="mt-1 max-w-3xl text-xs text-muted-foreground/80">
          Default is the state a newly provisioned (non-admin) user
          starts with before any change.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {PERMISSION_CATEGORIES.map((category) => (
            <StandardCollapsibleSection
              key={category.id}
              sectionKey={category.id}
              label={category.label}
              badge={`${category.keys.length}`}
              defaultExpanded
              storagePrefix="mwgcrm.admin.permissions.help.category."
              domIdPrefix="admin-perm-help-category-"
            >
              <div className="flex flex-col divide-y divide-border">
                {category.keys.map((key) => {
                  const meta = PERMISSION_LABELS[key];
                  const on = PERMISSION_DEFAULT_ON.has(key);
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
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {key}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground/80">
                          {meta.hint}
                        </p>
                      </div>
                      <span
                        className={
                          on
                            ? "mt-0.5 inline-block shrink-0 rounded-full border border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--status-won-fg)]"
                            : "mt-0.5 inline-block shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                        }
                        title="Default for a new non-admin user"
                      >
                        {on ? "On" : "Off"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </StandardCollapsibleSection>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Admin and breakglass
        </h2>
        <GlassCard className="mt-3 p-5">
          <p className="max-w-3xl text-sm text-foreground/90">
            <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
              isAdmin
            </code>{" "}
            is a separate field, not a permission. It bypasses every
            permission above and grants access to{" "}
            <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
              /admin
            </code>
            . Toggling per-feature permissions on an admin has no visible
            effect. It defaults to off.
          </p>
          <p className="mt-3 max-w-3xl text-sm text-foreground/90">
            The breakglass account is created with{" "}
            <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
              isAdmin = true
            </code>
            , so it has full access regardless of its individual
            permission columns — see{" "}
            <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
              src/lib/breakglass.ts
            </code>
            . That keeps a recovery path even if every other admin is
            locked out.
          </p>
        </GlassCard>
      </section>
    </div>
  );
}
