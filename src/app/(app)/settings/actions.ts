"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { accounts, users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Phase 3B server actions for /settings. Editable fields auto-save on
 * change — each action validates a small slice of the prefs schema and
 * upserts. Read-only Entra-synced fields are NEVER writable here.
 *
 * Every mutation is audit-logged so admins can see prefs drift.
 */

const updatePreferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  defaultLandingPage: z.enum([
    "/dashboard",
    "/leads",
    "/leads?view=builtin:my-open",
    "/leads?view=builtin:all-mine",
    "/leads?view=builtin:recent",
    "/custom",
  ]).optional(),
  customLandingPath: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/(dashboard|leads|opportunities|accounts|contacts|tasks)(\?.*)?$/, {
      message: "Path must start with /dashboard, /leads, /opportunities, /accounts, /contacts, or /tasks",
    })
    .nullable()
    .optional(),
  defaultLeadsViewId: z.string().uuid().nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  dateFormat: z.enum(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]).optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  tableDensity: z.enum(["comfortable", "compact"]).optional(),
  notifyTasksDue: z.boolean().optional(),
  notifyTasksAssigned: z.boolean().optional(),
  notifyMentions: z.boolean().optional(),
  notifySavedSearch: z.boolean().optional(),
  emailDigestFrequency: z.enum(["off", "daily", "weekly"]).optional(),
  leadsDefaultMode: z.enum(["table", "pipeline"]).optional(),
});

export type PreferencesPatch = z.infer<typeof updatePreferencesSchema>;

export async function updatePreferencesAction(
  patch: PreferencesPatch & { version?: number },
): Promise<
  { ok: true; version: number } | { ok: false; error: string }
> {
  const session = await requireSession();

  // Phase 6B — extract version from the patch before Zod validates the
  // pref slice. Optional: a brand-new prefs row has no version yet, so
  // first-save can omit it.
  const expectedVersion = patch.version;
  const cleanPatch: Record<string, unknown> = { ...patch };
  delete cleanPatch.version;

  const parsed = updatePreferencesSchema.safeParse(cleanPatch);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  try {
    const set: Record<string, unknown> = {
      ...parsed.data,
      updatedAt: sql`now()`,
      version: sql`${userPreferences.version} + 1`,
    };
    // INSERT new prefs row OR conditionally UPDATE existing one. The
    // ON CONFLICT DO UPDATE ... WHERE filters out conflicting writes:
    // when expected version is provided, the update only fires if
    // version matches. Empty rows = no row matched = conflict.
    const rows = await db
      .insert(userPreferences)
      .values({ userId: session.id, ...parsed.data })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set,
        setWhere:
          expectedVersion !== undefined
            ? eq(userPreferences.version, expectedVersion)
            : undefined,
      })
      .returning({ version: userPreferences.version });

    if (rows.length === 0) {
      throw new ConflictError(
        "Your preferences were modified in another tab. Refresh to see the latest, then try again.",
        { userId: session.id, expectedVersion },
      );
    }

    await writeAudit({
      actorId: session.id,
      action: "user_preferences.update",
      targetType: "user_preferences",
      targetId: session.id,
      after: parsed.data,
    });

    revalidatePath("/settings");
    return { ok: true, version: rows[0].version };
  } catch (err) {
    if (err instanceof ConflictError) {
      return { ok: false, error: err.publicMessage };
    }
    logger.error("settings.update_preferences_failed", {
      userId: session.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not save preferences." };
  }
}

/**
 * "Sign out everywhere" — bumps session_version, kicking every other
 * device on its next request. The current device's JWT is also
 * invalidated, so the user has to sign in again here too.
 */
export async function signOutEverywhereAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const session = await requireSession();
  try {
    await db
      .update(users)
      .set({ sessionVersion: sql`session_version + 1`, updatedAt: sql`now()` })
      .where(eq(users.id, session.id));
    await writeAudit({
      actorId: session.id,
      action: "user.sign_out_everywhere",
      targetType: "users",
      targetId: session.id,
    });
    return { ok: true };
  } catch (err) {
    logger.error("settings.sign_out_everywhere_failed", {
      userId: session.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not sign out everywhere." };
  }
}

/**
 * "Disconnect" — clears the stored Microsoft Graph tokens so the user's
 * delegated Graph features (email send, calendar) are disabled until they
 * reconnect. Does NOT sign them out — they keep their current session.
 */
export async function disconnectGraphAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const session = await requireSession();
  try {
    await db
      .update(accounts)
      .set({
        access_token: null,
        refresh_token: null,
        expires_at: null,
        id_token: null,
      })
      .where(eq(accounts.userId, session.id));
    await writeAudit({
      actorId: session.id,
      action: "user.disconnect_graph",
      targetType: "accounts",
      targetId: session.id,
    });
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error("settings.disconnect_graph_failed", {
      userId: session.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not disconnect Microsoft 365." };
  }
}
