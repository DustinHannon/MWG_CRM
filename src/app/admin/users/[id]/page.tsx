import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { DeleteUserButton } from "./delete-user";
import { UserActions } from "./user-actions";

export const dynamic = "force-dynamic";

const PERMISSION_LABELS: Array<[
  keyof typeof permissions.$inferSelect,
  string,
  string,
]> = [
  ["canViewAllRecords", "View all leads", "See leads owned by anyone (otherwise only own / assigned)"],
  ["canCreateLeads", "Create leads", "Add new leads to the system"],
  ["canEditLeads", "Edit leads", "Modify lead fields"],
  ["canDeleteLeads", "Delete leads", "Permanently remove leads"],
  ["canImport", "Import (XLSX)", "Bulk-import leads from spreadsheets"],
  ["canExport", "Export (XLSX)", "Download filtered leads as XLSX"],
  ["canSendEmail", "Send email", "Send messages from the lead detail page"],
  ["canViewReports", "View reports", "Access dashboard analytics"],
];

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

  const permsRow = await db
    .select()
    .from(permissions)
    .where(eq(permissions.userId, id))
    .limit(1);
  const perms = permsRow[0] ?? null;

  const isSelf = admin.id === u.id;

  return (
    <div className="px-10 py-10">
      <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground/80">User</p>
      <h1 className="mt-1 text-2xl font-semibold">{u.displayName}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {u.email} · {u.username}
        {u.isBreakglass ? (
          <span className="ml-3 inline-block rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">
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
        permissions={perms ? PERMISSION_LABELS.map(([k, label, hint]) => ({
          key: k,
          label,
          hint,
          value: Boolean((perms as unknown as Record<string, boolean>)[k]),
        })) : []}
      />

      {/* Danger zone — phase 2F.4 */}
      <section className="mt-10 rounded-2xl border border-rose-300/30 bg-rose-500/5 p-6">
        <h2 className="text-xs font-medium uppercase tracking-wide text-rose-100">
          Danger zone
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {isSelf
            ? "You cannot delete your own account."
            : u.isBreakglass
              ? "The breakglass account cannot be deleted."
              : "Removes the user, their personal saved views and preferences, OAuth links, and active sessions. Owned leads must be reassigned or deleted as part of the flow."}
        </p>
        <div className="mt-4">
          <DeleteUserButton
            userId={u.id}
            disabled={isSelf || u.isBreakglass}
            disabledReason={
              isSelf
                ? "Cannot delete yourself."
                : u.isBreakglass
                  ? "Cannot delete the breakglass account."
                  : undefined
            }
          />
        </div>
      </section>
    </div>
  );
}
