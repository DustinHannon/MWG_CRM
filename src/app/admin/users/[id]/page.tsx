import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { RoleBundleSelector } from "@/components/admin/role-bundle-selector";
import { getPermissions, requireAdmin } from "@/lib/auth-helpers";
import { SYSTEM_SENTINEL_USER_ID } from "@/lib/constants/system-users";
import { DeleteUserButton } from "./delete-user";
import { PermissionsEditor } from "./permissions-editor";
import { RecheckMailboxButton } from "./recheck-mailbox-button";
import { UserActions } from "./user-actions";

export const dynamic = "force-dynamic";

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  const { id } = await params;

  const userRow = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!userRow[0]) notFound();
  const u = userRow[0];

  const perms = await getPermissions(u.id);
  const isSelf = admin.id === u.id;
  const isSystemAccount = u.id === SYSTEM_SENTINEL_USER_ID;

  // The permission map is the single source of truth. RoleBundleSelector
  // and PermissionsEditor each seed local state from these props ONCE
  // (useState/useMemo), so after applyRoleBundleAction / Save revalidates
  // this route they would keep showing the pre-mutation toggles until a
  // full reload. Key both on a stable signature of the permission values
  // so they remount with fresh state when — and only when — a permission
  // actually changed (React-canonical state reset; unrelated revalidations
  // keep the key stable and do not disturb an in-progress edit).
  const permsKey = (Object.keys(perms) as (keyof typeof perms)[])
    .sort()
    .map((k) => `${String(k)}:${perms[k] ? 1 : 0}`)
    .join("|");

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Users", href: "/admin/users" },
          { label: u.displayName },
        ]}
      />
      <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground/80">
        User
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{u.displayName}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {u.email} · {u.username}
        {u.isBreakglass ? (
          <span className="ml-3 inline-block rounded-full border border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--priority-medium-fg)]">
            Breakglass
          </span>
        ) : null}
      </p>

      <UserActions
        userId={u.id}
        isAdmin={u.isAdmin}
        isActive={u.isActive}
        isBreakglass={u.isBreakglass}
        isSelf={isSelf}
      />

      <div className="mt-8">
        <RoleBundleSelector
          key={permsKey}
          userId={u.id}
          currentPermissions={perms}
          isBreakglass={u.isBreakglass}
        />
      </div>

      <PermissionsEditor
        key={permsKey}
        userId={u.id}
        initialPermissions={perms}
        isBreakglass={u.isBreakglass}
      />

      {!u.isBreakglass ? (
        <section className="mt-8 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Mailbox
          </h2>
          <p className="mt-1 text-xs text-muted-foreground/80">
            Cached for 24 hours and refreshed on every sign-in. Re-check
            forces a fresh Microsoft Graph probe.
          </p>
          <div className="mt-4 max-w-md">
            <RecheckMailboxButton
              userId={u.id}
              initialKind={u.mailboxKind}
              initialCheckedAt={
                u.mailboxCheckedAt ? u.mailboxCheckedAt.toISOString() : null
              }
            />
          </div>
        </section>
      ) : null}

      <section className="mt-10 rounded-2xl border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)]/40 p-6">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--status-lost-fg)]">
          Danger zone
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {isSelf
            ? "You cannot delete your own account."
            : u.isBreakglass
              ? "The breakglass account cannot be deleted."
              : isSystemAccount
                ? "The system account cannot be deleted. It owns system-attributed audit, email, and job history."
                : "Removes the user, their personal saved views and preferences, OAuth links, and active sessions. Owned records are reassigned or deleted as part of the flow."}
        </p>
        <div className="mt-4">
          <DeleteUserButton
            userId={u.id}
            disabled={isSelf || u.isBreakglass || isSystemAccount}
            disabledReason={
              isSelf
                ? "Cannot delete yourself."
                : u.isBreakglass
                  ? "Cannot delete the breakglass account."
                  : isSystemAccount
                    ? "Cannot delete the system account."
                    : undefined
            }
          />
        </div>
      </section>
    </div>
  );
}
