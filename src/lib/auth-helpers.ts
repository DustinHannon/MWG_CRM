import "server-only";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { permissions, users } from "@/db/schema/users";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  photoUrl: string | null;
  jobTitle: string | null;
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
      photoUrl: users.photoBlobUrl,
      jobTitle: users.jobTitle,
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

/**
 * Forbidden — used by helpers that throw rather than redirect, e.g. when
 * called from a server action that wants to return an error result.
 */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Verify the user can access a specific lead. Closes the horizontal
 * privilege escalation where a server action accepts a leadId from form
 * data but does not check whether the actor owns it or has the
 * canViewAllLeads flag. Admin always passes.
 *
 * Throws `ForbiddenError` if the lead doesn't exist or the user can't
 * access it. Returns the lead row's owner_id on success so callers don't
 * need to re-fetch.
 */
export async function requireLeadAccess(
  user: SessionUser,
  leadId: string,
): Promise<{ ownerId: string | null }> {
  const row = await db
    .select({ ownerId: leads.ownerId })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row[0]) throw new ForbiddenError("Lead not found.");

  if (user.isAdmin) return { ownerId: row[0].ownerId };

  // Non-admin: must be owner OR have canViewAllLeads.
  if (row[0].ownerId === user.id) return { ownerId: row[0].ownerId };

  const perm = await db
    .select({ canViewAllLeads: permissions.canViewAllLeads })
    .from(permissions)
    .where(eq(permissions.userId, user.id))
    .limit(1);
  if (perm[0]?.canViewAllLeads) return { ownerId: row[0].ownerId };

  throw new ForbiddenError("You don't have access to this lead.");
}

/**
 * For settings / profile mutations: must be admin OR the user themselves.
 * Throws ForbiddenError on failure.
 */
export function requireSelfOrAdmin(user: SessionUser, targetUserId: string): void {
  if (user.isAdmin) return;
  if (user.id === targetUserId) return;
  throw new ForbiddenError("You can only modify your own account.");
}

/** Combined lead access + lead-edit permission gate. */
export async function requireLeadEditAccess(
  user: SessionUser,
  leadId: string,
): Promise<{ ownerId: string | null }> {
  if (!user.isAdmin) {
    const perm = await db
      .select({ canEditLeads: permissions.canEditLeads })
      .from(permissions)
      .where(eq(permissions.userId, user.id))
      .limit(1);
    if (!perm[0]?.canEditLeads) {
      throw new ForbiddenError("You don't have permission to edit leads.");
    }
  }
  return requireLeadAccess(user, leadId);
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
