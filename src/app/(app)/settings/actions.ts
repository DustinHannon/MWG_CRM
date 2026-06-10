"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { accounts, users } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * server actions for /settings. Editable fields auto-save on
 * change — each action validates a small slice of the prefs schema and
 * upserts. Read-only Entra-synced fields are NEVER writable here.
 *
 * Every mutation is audit-logged so admins can see prefs drift.
 */

const updatePreferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  defaultLandingPage: z
    .enum([
      "/dashboard",
      "/leads",
      "/leads?view=builtin:my-open",
      "/leads?view=builtin:all-mine",
      "/leads?view=builtin:recent",
      "/custom",
    ])
    .optional(),
  customLandingPath: z
    .string()
    .trim()
    .max(200)
    .regex(
      /^\/(dashboard|leads|opportunities|accounts|contacts|tasks)(\?.*)?$/,
      {
        message:
          "Path must start with /dashboard, /leads, /opportunities, /accounts, /contacts, or /tasks",
      },
    )
    .nullable()
    .optional(),
  defaultLeadsViewId: z.string().uuid().nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  dateFormat: z.enum(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]).optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  tableDensity: z.enum(["comfortable", "compact"]).optional(),
  // sidebar collapsed/expanded state. Persisted so the
  // chrome stays consistent across sessions and devices.
  sidebarCollapsed: z.boolean().optional(),
  notifyTasksDue: z.boolean().optional(),
  notifyTasksAssigned: z.boolean().optional(),
  notifyMentions: z.boolean().optional(),
  notifySavedSearch: z.boolean().optional(),
  emailDigestFrequency: z.enum(["off", "daily", "weekly"]).optional(),
  leadsDefaultMode: z.enum(["table", "pipeline"]).optional(),
});

export type PreferencesPatch = z.infer<typeof updatePreferencesSchema>;

export interface PreferencesUpdateData {
  version: number;
}

// max attempts to re-read-and-update when a genuine concurrent
// writer bumps the version between our read and our conditional update.
// The settings page is single-owner, so true contention is rare and a
// short bounded retry resolves it without surfacing a spurious conflict.
const MAX_OCC_ATTEMPTS = 3;

export async function updatePreferencesAction(
  patch: PreferencesPatch,
): Promise<ActionResult<PreferencesUpdateData>> {
  return withErrorBoundary(
    { action: "user_preferences.update" },
    async (): Promise<PreferencesUpdateData> => {
      const session = await requireSession();

      const parsed = updatePreferencesSchema.parse(patch);

      // Re-read the current version server-side on each attempt rather
      // than trusting a client-supplied cursor. The /settings page renders
      // two independent sub-sections (Preferences + Notifications) that both
      // write this single user_preferences row; a per-section client cursor
      // desyncs after the first save and produces a false "modified in
      // another tab" conflict on normal single-page use. Reading the version
      // here keeps OCC honest against a genuine concurrent writer while never
      // false-conflicting on a single owner's own page.
      for (let attempt = 0; attempt < MAX_OCC_ATTEMPTS; attempt++) {
        const beforeRows = await db
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.userId, session.id))
          .limit(1);
        const before = beforeRows[0] ?? null;

        if (before === null) {
          // No row yet: INSERT. If a concurrent request inserts first, the
          // ON CONFLICT DO NOTHING returns 0 rows and we loop to UPDATE it.
          const inserted = await db
            .insert(userPreferences)
            .values({ userId: session.id, ...parsed })
            .onConflictDoNothing({ target: userPreferences.userId })
            .returning({ version: userPreferences.version });

          if (inserted.length === 0) {
            continue;
          }

          await writeAudit({
            actorId: session.id,
            action: "user_preferences.update",
            targetType: "user_preferences",
            targetId: session.id,
            before: null,
            after: parsed,
          });

          revalidatePath("/settings");
          return { version: inserted[0].version };
        }

        // Existing row: conditionally UPDATE guarded by the version we just
        // read. A 0-row result means another request bumped it in between;
        // loop to re-read the fresh version and retry.
        const updated = await db
          .update(userPreferences)
          .set({
            ...parsed,
            updatedAt: sql`now()`,
            version: sql`${userPreferences.version} + 1`,
          })
          .where(
            and(
              eq(userPreferences.userId, session.id),
              eq(userPreferences.version, before.version),
            ),
          )
          .returning({ version: userPreferences.version });

        if (updated.length === 0) {
          continue;
        }

        await writeAudit({
          actorId: session.id,
          action: "user_preferences.update",
          targetType: "user_preferences",
          targetId: session.id,
          before,
          after: parsed,
        });

        revalidatePath("/settings");
        return { version: updated[0].version };
      }

      throw new ConflictError(
        "Your preferences were modified in another tab. Refresh to see the latest, then try again.",
        { userId: session.id },
      );
    },
  );
}

/**
 * "Sign out everywhere" — bumps session_version, kicking every other
 * device on its next request. The current device's JWT is also
 * invalidated, so the user has to sign in again here too.
 */
export async function signOutEverywhereAction(): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "user.sign_out_everywhere" },
    async () => {
      const session = await requireSession();
      await db
        .update(users)
        .set({
          sessionVersion: sql`session_version + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, session.id));
      await writeAudit({
        actorId: session.id,
        action: "user.sign_out_everywhere",
        targetType: "users",
        targetId: session.id,
      });
    },
  );
}

/**
 * "Disconnect" — clears the stored Microsoft Graph tokens so the user's
 * delegated Graph features (email send, calendar) are disabled until they
 * reconnect. Does NOT sign them out — they keep their current session.
 */
export async function disconnectGraphAction(): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "user.disconnect_graph" },
    async () => {
      const session = await requireSession();
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
    },
  );
}
