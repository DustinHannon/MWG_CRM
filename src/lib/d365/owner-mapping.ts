import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { D365_AUDIT_EVENTS } from "./audit-events";
import { getD365Env } from "./env";

/**
 * Phase 23 — D365 owner → mwg-crm user resolution.
 *
 * Q-05 decision: three-path resolution with default-owner fallback.
 *
 *  1. EXISTING — D365 systemuser has a `domainname` (Entra UPN). Look
 *     up `users.email` exact-match (case-insensitive). Use the row
 *     verbatim if found.
 *
 *  2. JIT — UPN resolves to an Entra account in the MWG tenant but
 *     no `users` row exists yet. Create one mirroring the Phase 15
 *     `user.create.jit` pattern. Emit
 *     `d365.import.owner.jit_provisioned`.
 *
 *  3. DEFAULT OWNER — UPN cannot be resolved (former employee, system
 *     account, no email on D365 owner record). Assign to the
 *     configured default-owner email (D365_DEFAULT_OWNER_EMAIL,
 *     default `dustin.hannon@morganwhite.com`). The user explicitly
 *     chose this over a placeholder/unassigned account so unattributed
 *     imports land somewhere a human will see them.
 *
 * NOTE: This module is a SKELETON. The JIT path requires a Microsoft
 * Graph lookup against the configured tenant which Sub-agent A wires
 * in. Until then the resolver returns 'default_owner' for any
 * non-existing user. The §4.5 H-4 halt threshold (≥ 5 records in a
 * batch falling to default_owner) provides the explicit user gate.
 */

export type OwnerResolutionSource =
  | "existing"
  | "jit_provisioned"
  | "default_owner";

export interface ResolvedOwner {
  userId: string;
  source: OwnerResolutionSource;
}

/**
 * Resolve a D365 systemuser's UPN/email to a mwg-crm `users.id`.
 *
 * @param email Lowercased Entra UPN (D365 `domainname`).
 * @param actorId The admin running the import — required for the
 *                `user.create.jit` audit trail when JIT fires.
 */
export async function resolveD365Owner(
  email: string | null | undefined,
  actorId: string,
): Promise<ResolvedOwner> {
  const normalized = (email ?? "").trim().toLowerCase();

  if (normalized) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);
    if (existing[0]) {
      return { userId: existing[0].id, source: "existing" };
    }

    // TODO(phase-23/sub-agent-A): Microsoft Graph lookup against
    // ENTRA_TENANT_ID for `${normalized}` to confirm the UPN exists
    // in the tenant before JIT-provisioning. Mirrors Phase 15's
    // `user.create.jit` flow.
    //
    // Until that wiring lands, fall through to the default owner so
    // the pipeline can be exercised end-to-end. The §4.5 H-4 halt
    // threshold (≥ 5 default-owner fallbacks per batch) is the
    // explicit gate for human review.
    logger.warn("d365.owner_mapping.unresolved_email", {
      email: normalized,
      reason: "graph_lookup_not_yet_implemented",
    });
  }

  return getDefaultOwner();
}

/**
 * Idempotent JIT user provisioning. Writes audit on first creation.
 * Skeleton — Sub-agent A fills in once Graph lookup confirms UPN.
 */
export async function jitProvisionD365Owner(
  email: string,
  displayName: string,
  actorId: string,
): Promise<ResolvedOwner> {
  const normalized = email.trim().toLowerCase();

  // Idempotent: another concurrent caller may have just created.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing[0]) {
    return { userId: existing[0].id, source: "existing" };
  }

  // TODO(phase-23/sub-agent-A): real INSERT with proper schema fields
  // matching Phase 15 JIT pattern (`status='pending'`, `is_active=true`,
  // `role=null`, `created_via='d365_import'`).
  void displayName; // suppress unused-parameter lint until impl lands

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.OWNER_JIT_PROVISIONED,
    targetType: "user",
    targetId: actorId, // placeholder until impl
    after: { email: normalized, jit: true },
  });

  return getDefaultOwner();
}

/**
 * Returns the default-owner user (Q-05). Reads
 * D365_DEFAULT_OWNER_EMAIL from env (default
 * `dustin.hannon@morganwhite.com`) and looks up the matching row.
 *
 * If the default-owner email doesn't match any user, the function
 * throws — that's a bootstrap failure, not a runtime fallback path.
 * The user must exist in mwg-crm before imports can run.
 */
async function getDefaultOwner(): Promise<ResolvedOwner> {
  const { defaultOwnerEmail } = getD365Env();
  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, defaultOwnerEmail))
    .limit(1);
  if (!owner[0]) {
    throw new Error(
      `D365 default-owner '${defaultOwnerEmail}' not found in users table. Set D365_DEFAULT_OWNER_EMAIL to an existing user's email.`,
    );
  }
  return { userId: owner[0].id, source: "default_owner" };
}
