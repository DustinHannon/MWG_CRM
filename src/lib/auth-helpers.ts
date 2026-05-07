import "server-only";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
}

/**
 * Throws (via redirect) if the request has no session. Use in server
 * components and server actions before doing any authorized work.
 */
export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

  // Trust-but-verify against DB. Catches a JWT minted before
  // is_active was flipped, between session checks.
  const fresh = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const u = fresh[0];
  if (!u) redirect("/auth/signin");
  if (!u.isActive) redirect("/auth/disabled");
  return u;
}

/** Same as requireSession but redirects to /dashboard if not admin. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireSession();
  if (!u.isAdmin) redirect("/dashboard");
  return u;
}

export type PermissionKey =
  | "canViewAllLeads"
  | "canCreateLeads"
  | "canEditLeads"
  | "canDeleteLeads"
  | "canImport"
  | "canExport"
  | "canSendEmail"
  | "canViewReports";

/**
 * Admin bypasses all per-feature permission checks.
 * Throws via redirect on miss.
 */
export async function requirePermission(
  user: SessionUser,
  key: PermissionKey,
): Promise<void> {
  if (user.isAdmin) return;
  const row = await db
    .select({ [key]: permissions[key] })
    .from(permissions)
    .where(eq(permissions.userId, user.id))
    .limit(1);
  if (!row[0] || !(row[0] as Record<string, boolean>)[key]) {
    redirect("/dashboard");
  }
}

/** Read all permissions for a user. Returns defaults if no row exists. */
export async function getPermissions(
  userId: string,
): Promise<Record<PermissionKey, boolean>> {
  const row = await db
    .select()
    .from(permissions)
    .where(eq(permissions.userId, userId))
    .limit(1);
  if (!row[0]) {
    return {
      canViewAllLeads: false,
      canCreateLeads: true,
      canEditLeads: true,
      canDeleteLeads: false,
      canImport: false,
      canExport: false,
      canSendEmail: true,
      canViewReports: true,
    };
  }
  const r = row[0];
  return {
    canViewAllLeads: r.canViewAllLeads,
    canCreateLeads: r.canCreateLeads,
    canEditLeads: r.canEditLeads,
    canDeleteLeads: r.canDeleteLeads,
    canImport: r.canImport,
    canExport: r.canExport,
    canSendEmail: r.canSendEmail,
    canViewReports: r.canViewReports,
  };
}
