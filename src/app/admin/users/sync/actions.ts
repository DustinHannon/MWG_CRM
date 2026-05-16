"use server";

import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { leads } from "@/db/schema/leads";
import { crmAccounts, contacts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { requireAdmin } from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { AUDIT_EVENTS } from "@/lib/audit/events";
import { createNotifications } from "@/lib/notifications";
import { env } from "@/lib/env";
import { SYSTEM_SENTINEL_USER_ID } from "@/lib/constants/system-users";
import {
  createOrUpdateUserFromEntraProfile,
  normalizeDirectoryUserToProfile,
} from "@/lib/entra-provisioning";
import {
  classifyDirectoryUser,
  fetchEntraDirectoryUsers,
} from "@/lib/entra/directory-sync";

/**
 * Admin-gated server actions for the Entra user-sync wizard.
 *
 * Every exported action calls `requireAdmin()` as its first statement —
 * a non-admin who guesses the action/URL is redirected to /dashboard,
 * never served. Directory data is always re-pulled from Graph on the
 * commit path; the client never supplies the authoritative user list,
 * only the set of opaque Entra object ids it selected.
 */

// A directory user surfaced in the wizard's import column.
export interface SyncCandidate {
  entraOid: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  department: string | null;
  accountEnabled: boolean;
  userType: string;
  alreadyInCrm: boolean;
  recommended: boolean;
  reasons: string[];
}

// An existing CRM user absent from the live Entra directory.
export interface OffboardCandidate {
  userId: string;
  displayName: string;
  email: string;
  isActive: boolean;
  leadCount: number;
}

export interface EntraSyncPreview {
  jobId: string;
  fetchedAt: string;
  permissionError?: string;
  candidates: SyncCandidate[];
  offboard: OffboardCandidate[];
  reassignTargets: { id: string; label: string }[];
}

export interface CommitResult {
  created: number;
  updated: number;
  failed: { entraOid: string; error: string }[];
  processed: number;
  totalSelected: number;
  stoppedEarly: boolean;
}

export interface OffboardResult {
  deactivated: number;
  reassigned: number;
  failed: { userId: string; error: string }[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when a provisioning failure is a unique-constraint violation on
 * the username index — the actionable case (a multi-domain UPN collision
 * mapping two Entra accounts onto one sign-in name). Narrows `unknown`
 * without `any`: checks the Error message and a Postgres `code`/
 * `cause.code` of "23505" referencing the username constraint.
 */
function isUsernameUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes("users_username_uniq")) return true;
  const pgCode = (e: unknown): string | undefined => {
    if (e && typeof e === "object" && "code" in e) {
      const c = (e as { code?: unknown }).code;
      if (typeof c === "string") return c;
    }
    return undefined;
  };
  const refsUsername =
    err.message.includes("users_username_uniq") ||
    err.message.toLowerCase().includes("username");
  if (pgCode(err) === "23505" && refsUsername) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (pgCode(cause) === "23505") {
    const causeMsg =
      cause instanceof Error ? cause.message : String(cause ?? "");
    if (
      causeMsg.includes("users_username_uniq") ||
      causeMsg.toLowerCase().includes("username")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build the wizard preview: every directory user (classified + CRM-match
 * annotated) plus the offboard list (CRM users absent from a *successful*
 * directory pull) and the reassignment-target dropdown.
 */
export async function loadEntraSyncPreview(): Promise<
  ActionResult<EntraSyncPreview>
> {
  return withErrorBoundary({ action: "admin.users.sync.preview" }, async () => {
    await requireAdmin();

    const dir = await fetchEntraDirectoryUsers();

    const existing = await db
      .select({
        id: users.id,
        email: users.email,
        entraOid: users.entraOid,
        displayName: users.displayName,
        isActive: users.isActive,
        isBreakglass: users.isBreakglass,
      })
      .from(users);

    const byOid = new Map<string, (typeof existing)[number]>();
    const byEmail = new Map<string, (typeof existing)[number]>();
    for (const u of existing) {
      if (u.entraOid) byOid.set(u.entraOid, u);
      if (u.email) byEmail.set(u.email.toLowerCase(), u);
    }

    const candidates: SyncCandidate[] = dir.users.map((u) => {
      const classification = classifyDirectoryUser(
        u,
        env.ALLOWED_EMAIL_DOMAINS,
      );
      const email = (u.mail ?? u.userPrincipalName ?? "").toLowerCase();
      const alreadyInCrm =
        byOid.has(u.id) || (email.length > 0 && byEmail.has(email));
      const reasons = alreadyInCrm
        ? [...classification.reasons, "Already in CRM"]
        : classification.reasons;
      return {
        entraOid: u.id,
        displayName: (u.displayName ?? "").trim(),
        email,
        jobTitle: u.jobTitle ?? null,
        department: u.department ?? null,
        accountEnabled: u.accountEnabled !== false,
        userType: u.userType ?? "Member",
        alreadyInCrm,
        recommended: classification.recommended && !alreadyInCrm,
        reasons,
      };
    });

    // Offboard candidates ONLY when the directory pull fully succeeded
    // AND was complete. A failed pull (!dir.ok) or a truncated one
    // (dir.truncated) would falsely make every unlisted CRM user look
    // "absent" and mass-deactivate them — never offboard then.
    let offboard: OffboardCandidate[] = [];
    if (dir.ok && dir.truncated !== true) {
      const liveEnabledOids = new Set<string>();
      const liveEnabledEmails = new Set<string>();
      for (const u of dir.users) {
        if (u.accountEnabled === false) continue;
        liveEnabledOids.add(u.id);
        const e = (u.mail ?? u.userPrincipalName ?? "").toLowerCase();
        if (e.length > 0) liveEnabledEmails.add(e);
      }

      const missing = existing.filter(
        (u) =>
          u.isActive &&
          !u.isBreakglass &&
          u.id !== SYSTEM_SENTINEL_USER_ID &&
          !(u.entraOid !== null && liveEnabledOids.has(u.entraOid)) &&
          !(
            u.email.length > 0 &&
            liveEnabledEmails.has(u.email.toLowerCase())
          ),
      );

      const missingIds = missing.map((u) => u.id);
      const leadCounts = new Map<string, number>();
      if (missingIds.length > 0) {
        const rows = await db
          .select({
            ownerId: leads.ownerId,
            n: sql<number>`count(*)::int`,
          })
          .from(leads)
          .where(inArray(leads.ownerId, missingIds))
          .groupBy(leads.ownerId);
        for (const r of rows) {
          if (r.ownerId) leadCounts.set(r.ownerId, r.n);
        }
      }

      offboard = missing.map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        email: u.email,
        isActive: u.isActive,
        leadCount: leadCounts.get(u.id) ?? 0,
      }));
    }

    const reassignTargets = existing
      .filter((u) => u.isActive && u.id !== SYSTEM_SENTINEL_USER_ID)
      .map((u) => ({
        id: u.id,
        label: `${u.displayName} (${u.email})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // A hard fetch failure (!dir.ok) always wins the banner slot; only
    // when the pull succeeded but was truncated do we surface the
    // softer "offboarding disabled" note (import still works).
    const banner = dir.permissionError
      ? dir.permissionError
      : dir.ok && dir.truncated === true
        ? "The Entra directory listing was incomplete — more users exist than were retrieved. Importing users still works, but offboarding is disabled so active employees who were not listed are not deactivated."
        : undefined;

    return {
      jobId: `entra-sync-${Date.now()}`,
      fetchedAt: new Date().toISOString(),
      ...(banner ? { permissionError: banner } : {}),
      candidates,
      offboard,
      reassignTargets,
    } satisfies EntraSyncPreview;
  });
}

const commitImportSchema = z.object({
  entraOids: z.array(z.string().min(1)).min(1).max(5000),
});

/**
 * Provision (insert or update) the selected directory users. The
 * directory is RE-PULLED here so provisioning always uses authoritative
 * Graph server data — the client only ever sends the selected oids, a
 * tampered client list cannot inject arbitrary profile fields.
 */
export async function commitEntraUserImport(
  input: unknown,
): Promise<ActionResult<CommitResult>> {
  return withErrorBoundary({ action: "admin.users.sync.commit" }, async () => {
    const admin = await requireAdmin();

    const parsed = commitImportSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ValidationError(
        first
          ? `${first.path.join(".") || "input"}: ${first.message}`
          : "Validation failed.",
      );
    }
    const requested = Array.from(new Set(parsed.data.entraOids));

    const dir = await fetchEntraDirectoryUsers();
    if (!dir.ok) {
      throw new ValidationError(
        dir.permissionError ?? "Could not read the Entra directory.",
      );
    }

    const selected = new Set(requested);
    const toProvision = dir.users.filter((u) => selected.has(u.id));

    let created = 0;
    let updated = 0;
    let processed = 0;
    let stoppedEarly = false;
    const failed: { entraOid: string; error: string }[] = [];
    const totalSelected = toProvision.length;

    // Self-imposed budget under the route's 300s function limit. We stop
    // ourselves at 240s — leaving headroom for the trailing audit,
    // summary notification, and response serialization — rather than
    // letting the platform kill the run mid-loop and lose the summary.
    // The path is idempotent (entra_oid→email→insert resolution turns
    // already-created users into UPDATEs), so the admin can re-run to
    // finish without duplicating anyone.
    const startedAt = Date.now();
    const BUDGET_MS = 240_000;
    const CHUNK = 25;
    for (let i = 0; i < toProvision.length; i += CHUNK) {
      if (Date.now() - startedAt > BUDGET_MS) {
        stoppedEarly = true;
        break;
      }
      const chunk = toProvision.slice(i, i + CHUNK);
      for (const u of chunk) {
        processed += 1;
        try {
          const profile = normalizeDirectoryUserToProfile(u);
          if (!profile.email || !profile.email.includes("@")) {
            failed.push({
              entraOid: u.id,
              error: "Missing or invalid email address.",
            });
            continue;
          }
          // Domain allowlist — exact parity with the interactive JIT
          // path's EntraDomainNotAllowedError invariant (entra-
          // provisioning.ts): same condition, fail-closed on an empty
          // allowlist. Never call the core provisioner for a disallowed
          // domain.
          const domain = profile.email.split("@")[1]?.toLowerCase();
          if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
            failed.push({
              entraOid: u.id,
              error: "Email domain is not in the allowed list",
            });
            continue;
          }
          try {
            const r = await createOrUpdateUserFromEntraProfile(profile, {
              source: "admin_sync",
            });
            if (r.created) {
              created += 1;
            } else {
              updated += 1;
            }
          } catch (provisionErr) {
            // Never leak the raw Postgres/internal string to the client.
            if (isUsernameUniqueViolation(provisionErr)) {
              failed.push({
                entraOid: u.id,
                error: `The sign-in name "${profile.username}" already belongs to another account — not imported (likely a multi-domain UPN collision).`,
              });
            } else {
              failed.push({
                entraOid: u.id,
                error: "Could not provision this user.",
              });
            }
          }
        } catch (err) {
          // Pre-provisioning failure (normalize/guard). Generic, sanitized.
          failed.push({ entraOid: u.id, error: errorMessage(err) });
        }
      }
      // Gentle inter-chunk pause to slow the loop and ease DB pressure.
      // Skipped after the final chunk and when we are stopping early.
      if (!stoppedEarly && i + CHUNK < toProvision.length) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    await writeAudit({
      actorId: admin.id,
      actorEmailSnapshot: admin.email,
      action: AUDIT_EVENTS.USER_SYNC_IMPORT,
      targetType: "user",
      after: {
        requested: requested.length,
        created,
        updated,
        failed: failed.length,
        processed,
        totalSelected,
        stoppedEarly,
        source: "entra_directory",
      },
    });

    // One run-summary notification replaces the per-user admin-bell
    // fan-out (suppressed for source=admin_sync in the core). Same active-
    // admin query as notifyAdminsOfNewUser. createNotifications is best-
    // effort and swallows its own errors — never wrapped in try/catch.
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
    if (admins.length > 0) {
      await createNotifications(
        admins.map((a) => ({
          userId: a.id,
          kind: "new_user_jit" as const,
          title: `Entra user import: ${created} created, ${updated} updated`,
          body: `Imported by ${admin.displayName}. ${failed.length} failed.${
            stoppedEarly
              ? " Stopped at the time limit — run the import again to finish; users already imported are skipped, not duplicated."
              : ""
          }`,
          link: "/admin/users",
        })),
      );
    }

    return {
      created,
      updated,
      failed,
      processed,
      totalSelected,
      stoppedEarly,
    } satisfies CommitResult;
  });
}

const offboardSchema = z.object({
  items: z
    .array(
      z.object({
        userId: z.string().uuid(),
        reassignTo: z.string().uuid().nullable(),
      }),
    )
    .min(1)
    .max(1000),
});

/**
 * Deactivate CRM users absent from the directory, optionally reassigning
 * their owned records first. Each user is processed in its own
 * transaction (reassign + deactivate are atomic per user); a failure on
 * one user does not roll back already-committed ones. Audit is emitted
 * after the tx commits and is best-effort (never wrapped in try/catch).
 */
export async function offboardMissingUsers(
  input: unknown,
): Promise<ActionResult<OffboardResult>> {
  return withErrorBoundary(
    { action: "admin.users.sync.offboard" },
    async () => {
      const admin = await requireAdmin();

      const parsed = offboardSchema.safeParse(input);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      let deactivated = 0;
      let reassigned = 0;
      const failed: { userId: string; error: string }[] = [];

      // The full set being offboarded in this batch — a reassign target
      // that is itself being deactivated would orphan the records again.
      const batchUserIds = new Set(
        parsed.data.items.map((i) => i.userId),
      );

      for (const item of parsed.data.items) {
        if (item.userId === admin.id) {
          failed.push({
            userId: item.userId,
            error: "Cannot offboard yourself",
          });
          continue;
        }
        if (item.userId === SYSTEM_SENTINEL_USER_ID) {
          failed.push({
            userId: item.userId,
            error: "Cannot offboard the system account",
          });
          continue;
        }

        try {
          let didReassign = false;
          await db.transaction(async (tx) => {
            const [target] = await tx
              .select({
                id: users.id,
                isBreakglass: users.isBreakglass,
                email: users.email,
              })
              .from(users)
              .where(eq(users.id, item.userId))
              .limit(1);

            if (!target) {
              throw new ValidationError("User not found");
            }
            if (target.isBreakglass) {
              throw new ValidationError(
                "Cannot offboard the breakglass account",
              );
            }

            if (item.reassignTo) {
              // Validate the reassignment target BEFORE any ownership
              // write so a bad target never partially moves records.
              if (item.reassignTo === item.userId) {
                throw new ValidationError(
                  "Cannot reassign a user to themselves",
                );
              }
              if (batchUserIds.has(item.reassignTo)) {
                throw new ValidationError(
                  "Reassignment target is also being offboarded",
                );
              }
              const [reassignTarget] = await tx
                .select({
                  id: users.id,
                  isActive: users.isActive,
                  isBreakglass: users.isBreakglass,
                })
                .from(users)
                .where(eq(users.id, item.reassignTo))
                .limit(1);
              if (!reassignTarget) {
                throw new ValidationError(
                  "Reassignment target not found",
                );
              }
              if (!reassignTarget.isActive) {
                throw new ValidationError(
                  "Reassignment target is not an active user",
                );
              }
              if (reassignTarget.isBreakglass) {
                throw new ValidationError(
                  "Cannot reassign to the breakglass account",
                );
              }

              await tx
                .update(leads)
                .set({ ownerId: item.reassignTo })
                .where(eq(leads.ownerId, item.userId));
              await tx
                .update(crmAccounts)
                .set({ ownerId: item.reassignTo })
                .where(eq(crmAccounts.ownerId, item.userId));
              await tx
                .update(contacts)
                .set({ ownerId: item.reassignTo })
                .where(eq(contacts.ownerId, item.userId));
              await tx
                .update(opportunities)
                .set({ ownerId: item.reassignTo })
                .where(eq(opportunities.ownerId, item.userId));
              await tx
                .update(tasks)
                .set({ assignedToId: item.reassignTo })
                .where(eq(tasks.assignedToId, item.userId));
              didReassign = true;
            }

            await tx
              .update(users)
              .set({
                isActive: false,
                sessionVersion: sql`${users.sessionVersion} + 1`,
                updatedAt: sql`now()`,
              })
              .where(eq(users.id, item.userId));
          });

          deactivated += 1;
          if (didReassign) reassigned += 1;

          await writeAudit({
            actorId: admin.id,
            actorEmailSnapshot: admin.email,
            action: AUDIT_EVENTS.USER_SYNC_OFFBOARD,
            targetType: "user",
            targetId: item.userId,
            after: {
              reassignedTo: item.reassignTo,
              reason: "absent_from_entra_directory",
            },
          });
        } catch (err) {
          failed.push({ userId: item.userId, error: errorMessage(err) });
        }
      }

      return { deactivated, reassigned, failed } satisfies OffboardResult;
    },
  );
}
