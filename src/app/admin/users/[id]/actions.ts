"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/password";

const PERMISSION_KEYS = [
  "canViewAllLeads",
  "canCreateLeads",
  "canEditLeads",
  "canDeleteLeads",
  "canImport",
  "canExport",
  "canSendEmail",
  "canViewReports",
] as const;
type PermissionKey = (typeof PERMISSION_KEYS)[number];

export async function updatePermission(formData: FormData) {
  const admin = await requireAdmin();

  const userId = z.string().uuid().parse(formData.get("userId"));
  const key = z.enum(PERMISSION_KEYS).parse(formData.get("key"));
  const value = formData.get("value") === "true";

  const before = await db
    .select({ [key]: permissions[key as PermissionKey] })
    .from(permissions)
    .where(eq(permissions.userId, userId))
    .limit(1);

  // upsert: insert if missing, otherwise update.
  await db
    .insert(permissions)
    .values({ userId, [key]: value })
    .onConflictDoUpdate({
      target: permissions.userId,
      set: { [key]: value },
    });

  await writeAudit({
    actorId: admin.id,
    action: "user.permission_change",
    targetType: "user",
    targetId: userId,
    before: { [key]: (before[0] as Record<string, boolean> | undefined)?.[key] ?? null },
    after: { [key]: value },
  });

  revalidatePath(`/admin/users/${userId}`);
}

export async function updateAdminFlag(formData: FormData) {
  const admin = await requireAdmin();
  const userId = z.string().uuid().parse(formData.get("userId"));
  const value = formData.get("value") === "true";

  if (userId === admin.id && !value) {
    throw new Error("Refusing to remove your own admin flag.");
  }

  const target = await db
    .select({ isAdmin: users.isAdmin, isBreakglass: users.isBreakglass })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target[0]) throw new Error("User not found.");
  if (target[0].isBreakglass && !value) {
    throw new Error("Cannot remove admin flag from the breakglass account.");
  }

  await db
    .update(users)
    .set({ isAdmin: value, updatedAt: sql`now()` })
    .where(eq(users.id, userId));

  await writeAudit({
    actorId: admin.id,
    action: "user.admin_flag_change",
    targetType: "user",
    targetId: userId,
    before: { isAdmin: target[0].isAdmin },
    after: { isAdmin: value },
  });

  revalidatePath(`/admin/users/${userId}`);
}

export async function updateActiveFlag(formData: FormData) {
  const admin = await requireAdmin();
  const userId = z.string().uuid().parse(formData.get("userId"));
  const value = formData.get("value") === "true";

  if (userId === admin.id && !value) {
    throw new Error("Refusing to deactivate yourself.");
  }

  const target = await db
    .select({ isActive: users.isActive, isBreakglass: users.isBreakglass })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target[0]) throw new Error("User not found.");
  if (target[0].isBreakglass && !value) {
    throw new Error("Cannot deactivate the breakglass account.");
  }

  await db
    .update(users)
    .set({
      isActive: value,
      sessionVersion: value ? sql`session_version` : sql`session_version + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, userId));

  await writeAudit({
    actorId: admin.id,
    action: "user.active_flag_change",
    targetType: "user",
    targetId: userId,
    before: { isActive: target[0].isActive },
    after: { isActive: value },
  });

  revalidatePath(`/admin/users/${userId}`);
}

export async function forceReauth(formData: FormData) {
  const admin = await requireAdmin();
  const userId = z.string().uuid().parse(formData.get("userId"));

  await db
    .update(users)
    .set({
      sessionVersion: sql`session_version + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, userId));

  await writeAudit({
    actorId: admin.id,
    action: "user.force_reauth",
    targetType: "user",
    targetId: userId,
  });

  revalidatePath(`/admin/users/${userId}`);
}

export interface RotateBreakglassResult {
  ok: boolean;
  password?: string;
  error?: string;
}

/**
 * Generate + hash a fresh password for the breakglass account. Returns the
 * plaintext exactly once so the admin can save it. Does not log it to
 * stdout (unlike initial seeding) — the surface is the modal.
 */
export async function rotateBreakglassPassword(): Promise<RotateBreakglassResult> {
  const admin = await requireAdmin();

  const target = await db
    .select({ id: users.id, isBreakglass: users.isBreakglass })
    .from(users)
    .where(eq(users.isBreakglass, true))
    .limit(1);

  if (!target[0]) {
    return { ok: false, error: "No breakglass user found." };
  }

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const plaintext = Buffer.from(bytes).toString("base64url");
  const hash = await hashPassword(plaintext);

  await db
    .update(users)
    .set({
      passwordHash: hash,
      sessionVersion: sql`session_version + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(users.id, target[0].id));

  await writeAudit({
    actorId: admin.id,
    action: "user.breakglass_rotated",
    targetType: "user",
    targetId: target[0].id,
  });

  return { ok: true, password: plaintext };
}
