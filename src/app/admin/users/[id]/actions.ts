"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import {
  getPermissions,
  requireAdmin,
  type PermissionKey,
} from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/password";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  ROLE_BUNDLES,
  resolveBundle,
  type MarketingRoleBundle,
} from "@/lib/permissions/role-bundles";
import { PERMISSION_CATEGORIES } from "@/lib/permissions/ui-categories";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Set of every permission key that may be written through the admin
 * UI. Derived from the same source-of-truth used to render the
 * UI so the action accepts exactly what the form can submit.
 */
const ALL_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set(
  PERMISSION_CATEGORIES.flatMap((c) => c.keys),
);

function filterToKnownKeys(
  input: Record<string, boolean>,
): Partial<Record<PermissionKey, boolean>> {
  const out: Partial<Record<PermissionKey, boolean>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALL_PERMISSION_KEYS.has(key as PermissionKey)) continue;
    out[key as PermissionKey] = value;
  }
  return out;
}

function computeDiff(
  before: Record<PermissionKey, boolean>,
  after: Record<PermissionKey, boolean>,
): Record<string, { before: boolean; after: boolean }> {
  const diff: Record<string, { before: boolean; after: boolean }> = {};
  for (const key of ALL_PERMISSION_KEYS) {
    const k = key as PermissionKey;
    if (before[k] !== after[k]) {
      diff[k] = { before: before[k], after: after[k] };
    }
  }
  return diff;
}

const updatePermissionsSchema = z.object({
  userId: z.string().uuid(),
  permissions: z.record(z.string(), z.boolean()),
});

/**
 * Atomically update every permission column for the target user. Reads
 * before + after snapshots so the audit row captures the full diff in
 * a single event rather than one event per toggle.
 */
export async function updateUserPermissions(
  input: unknown,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "permissions.bulk_change" },
    async () => {
      const admin = await requireAdmin();
      const parsed = updatePermissionsSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError("Invalid permission payload.");
      }

      const target = await db
        .select({ id: users.id, isBreakglass: users.isBreakglass })
        .from(users)
        .where(eq(users.id, parsed.data.userId))
        .limit(1);
      if (!target[0]) throw new NotFoundError("user");
      // The breakglass account must always hold every permission (it is
      // reconciled to all-true on cold start — see lib/breakglass.ts).
      // Reject the edit up front rather than let it appear to succeed
      // then be silently reverted. Mirrors the breakglass guard on
      // updateAdminFlag / updateActiveFlag.
      if (target[0].isBreakglass) {
        throw new ForbiddenError(
          "Cannot edit permissions on the breakglass account; it always holds every permission.",
        );
      }

      const filtered = filterToKnownKeys(parsed.data.permissions);

      const before = await getPermissions(parsed.data.userId);

      await db
        .insert(permissions)
        .values({ userId: parsed.data.userId, ...filtered })
        .onConflictDoUpdate({
          target: permissions.userId,
          set: filtered,
        });

      const after = await getPermissions(parsed.data.userId);
      const diff = computeDiff(before, after);

      // Skip the audit row when nothing actually changed (admin
      // clicked Save with a no-op payload). The UI already guards
      // against this via the dirty flag; this is defense-in-depth.
      if (Object.keys(diff).length > 0) {
        await writeAudit({
          actorId: admin.id,
          action: "permissions.bulk_change",
          targetType: "user",
          targetId: parsed.data.userId,
          before: { permissions: before },
          after: { permissions: after, diff },
        });
      }

      revalidatePath(`/admin/users/${parsed.data.userId}`);
    },
  );
}

const applyBundleSchema = z.object({
  userId: z.string().uuid(),
  bundleName: z.enum(
    Object.keys(ROLE_BUNDLES) as [MarketingRoleBundle, ...MarketingRoleBundle[]],
  ),
});

/**
 * Apply a marketing role bundle by overwriting every marketing
 * permission column on the target user. Other permission columns are
 * left untouched.
 */
export async function applyRoleBundleAction(
  input: unknown,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "permissions.role_bundle.apply" },
    async () => {
      const admin = await requireAdmin();
      const parsed = applyBundleSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError("Invalid bundle payload.");
      }

      const target = await db
        .select({ id: users.id, isBreakglass: users.isBreakglass })
        .from(users)
        .where(eq(users.id, parsed.data.userId))
        .limit(1);
      if (!target[0]) throw new NotFoundError("user");
      // Breakglass always holds every permission; a bundle would narrow
      // it. Reject up front (and it would be reverted on cold start
      // anyway — see lib/breakglass.ts). Mirrors updateAdminFlag.
      if (target[0].isBreakglass) {
        throw new ForbiddenError(
          "Cannot apply a role bundle to the breakglass account; it always holds every permission.",
        );
      }

      const before = await getPermissions(parsed.data.userId);
      const bundlePerms = resolveBundle(parsed.data.bundleName);

      await db
        .insert(permissions)
        .values({ userId: parsed.data.userId, ...bundlePerms })
        .onConflictDoUpdate({
          target: permissions.userId,
          set: bundlePerms,
        });

      const after = await getPermissions(parsed.data.userId);
      const diff = computeDiff(before, after);

      await writeAudit({
        actorId: admin.id,
        action: "permissions.role_bundle.apply",
        targetType: "user",
        targetId: parsed.data.userId,
        before: { permissions: before },
        after: {
          bundleName: parsed.data.bundleName,
          permissions: after,
          diff,
        },
      });

      revalidatePath(`/admin/users/${parsed.data.userId}`);
    },
  );
}

export async function updateAdminFlag(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "user.admin_flag_change" },
    async () => {
      const admin = await requireAdmin();
      const userId = z.string().uuid().parse(formData.get("userId"));
      const value = formData.get("value") === "true";

      if (userId === admin.id && !value) {
        throw new ForbiddenError("Refusing to remove your own admin flag.");
      }

      const target = await db
        .select({ isAdmin: users.isAdmin, isBreakglass: users.isBreakglass })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target[0]) throw new NotFoundError("user");
      if (target[0].isBreakglass && !value) {
        throw new ForbiddenError(
          "Cannot remove admin flag from the breakglass account.",
        );
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
    },
  );
}

export async function updateActiveFlag(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "user.active_flag_change" },
    async () => {
      const admin = await requireAdmin();
      const userId = z.string().uuid().parse(formData.get("userId"));
      const value = formData.get("value") === "true";

      if (userId === admin.id && !value) {
        throw new ForbiddenError("Refusing to deactivate yourself.");
      }

      const target = await db
        .select({ isActive: users.isActive, isBreakglass: users.isBreakglass })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target[0]) throw new NotFoundError("user");
      if (target[0].isBreakglass && !value) {
        throw new ForbiddenError("Cannot deactivate the breakglass account.");
      }

      await db
        .update(users)
        .set({
          isActive: value,
          sessionVersion: value
            ? sql`session_version`
            : sql`session_version + 1`,
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
    },
  );
}

export async function forceReauth(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "user.force_reauth" }, async () => {
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
  });
}

export interface RotateBreakglassData {
  password: string;
}

/**
 * Generate + hash a fresh password for the breakglass account. Returns the
 * plaintext exactly once so the admin can save it. Does not log it to
 * stdout (unlike initial seeding) — the surface is the modal.
 */
export async function rotateBreakglassPassword(): Promise<
  ActionResult<RotateBreakglassData>
> {
  return withErrorBoundary(
    { action: "user.breakglass_rotated" },
    async (): Promise<RotateBreakglassData> => {
      const admin = await requireAdmin();

      const target = await db
        .select({ id: users.id, isBreakglass: users.isBreakglass })
        .from(users)
        .where(eq(users.isBreakglass, true))
        .limit(1);

      if (!target[0]) {
        throw new ConflictError("No breakglass user found.");
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

      return { password: plaintext };
    },
  );
}
