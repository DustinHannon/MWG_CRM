import "server-only";
import { sql, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import {
  graphAppRequest,
  isGraphAppConfigured,
} from "@/lib/email/graph-app-token";
import { D365_AUDIT_EVENTS } from "./audit-events";
import { getD365Env } from "./env";

/**
 * in-process per-process cache of email → resolution
 * outcome. Speeds up an import run where many records share an owner
 * (typical D365 export pattern: one owner per ~100 leads). Keyed on
 * lowercased email; value is either the resolved user id (positive
 * hit) or `null` for "Graph confirmed no match, use default owner".
 *
 * Module-scoped so the cache lives for the lifetime of the lambda
 * instance. Each new Vercel function cold start gets a fresh cache —
 * that's fine because Graph re-lookups across cold starts are cheap
 * compared to a single import-run benefit.
 */
const ownerLookupCache = new Map<
  string,
  { userId: string | null; source: OwnerResolutionSource }
>();

/**
 * Graph `/users/{upn}` response shape. We only
 * consume the fields used to create a users row.
 */
interface GraphUserResponse {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string | null;
  userPrincipalName?: string;
}

/**
 * D365 owner → mwg-crm user resolution.
 *
 * Q-05 decision: three-path resolution with default-owner fallback.
 *
 * 1. EXISTING — D365 systemuser has a `domainname` (Entra UPN). Look
 * up `users.email` exact-match (case-insensitive). Use the row
 * verbatim if found.
 *
 * 2. JIT — UPN resolves to an Entra account in the MWG tenant but
 * no `users` row exists yet. Create one mirroring the
 * `user.create.jit` pattern. Emit
 * `d365.import.owner.jit_provisioned`.
 *
 * 3. DEFAULT OWNER — UPN cannot be resolved (former employee, system
 * account, no email on D365 owner record). Assign to the
 * configured default-owner email (D365_DEFAULT_OWNER_EMAIL,
 * default `dustin.hannon@morganwhite.com`). The user explicitly
 * chose this over a placeholder/unassigned account so unattributed
 * imports land somewhere a human will see them.
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
 * now wires the Microsoft Graph `/users/{upn}`
 * lookup that left as a TODO. Resolution order:
 *
 * 1. Cache hit (positive or negative) from this lambda instance.
 * 2. Local users.email exact match (case-insensitive).
 * 3. Graph `/users/{upn}` lookup. If 200, JIT-provision a users
 * row with entra_oid populated and `jit_provisioned=true`.
 * 4. Graph 404 / error → default owner.
 *
 * Every resolution result is cached in-process so a batch of 100
 * leads that share an owner only triggers one Graph call. The cache
 * does NOT persist across lambda cold starts; new instance pays
 * the lookup cost once per owner.
 *
 * @param email Lowercased Entra UPN (D365 `domainname`).
 * @param actorId The admin running the import — required for the
 * `user.create.jit` audit trail when JIT fires.
 */
export async function resolveD365Owner(
  email: string | null | undefined,
  actorId: string,
): Promise<ResolvedOwner> {
  const normalized = (email ?? "").trim().toLowerCase();

  if (!normalized) {
    return getDefaultOwner();
  }

  // 1. Cache hit.
  const cached = ownerLookupCache.get(normalized);
  if (cached) {
    if (cached.userId) {
      return { userId: cached.userId, source: cached.source };
    }
    return getDefaultOwner();
  }

  // 2. Existing user.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing[0]) {
    const resolved: ResolvedOwner = {
      userId: existing[0].id,
      source: "existing",
    };
    ownerLookupCache.set(normalized, {
      userId: resolved.userId,
      source: resolved.source,
    });
    return resolved;
  }

  // 3. Microsoft Graph JIT lookup.
  if (!isGraphAppConfigured()) {
    // Cannot do JIT without Graph credentials. Fall through to
    // default owner; do NOT cache (so a deploy that adds credentials
    // later picks them up immediately on the next call).
    logger.warn("d365.owner_mapping.graph_not_configured", {
      email: normalized,
    });
    await writeAudit({
      actorId,
      action: D365_AUDIT_EVENTS.OWNER_JIT_FAILED,
      targetType: "user",
      after: { email: normalized, reason: "graph_not_configured" },
    });
    return getDefaultOwner();
  }

  const graphRes = await graphAppRequest<GraphUserResponse>(
    "GET",
    `/users/${encodeURIComponent(normalized)}`,
  );

  if (!graphRes.ok) {
    // 404 = user genuinely doesn't exist in the tenant (former
    // employee, system account, typo). Any other error = transient
    // Graph issue; treat as fail-closed for this batch but DON'T
    // cache the failure so the next batch retries.
    const isNotFound = graphRes.status === 404;
    if (!isNotFound) {
      logger.warn("d365.owner_mapping.graph_lookup_failed", {
        email: normalized,
        status: graphRes.status,
        errorCode: graphRes.error?.code,
        errorMessage: graphRes.error?.message,
      });
    }
    await writeAudit({
      actorId,
      action: D365_AUDIT_EVENTS.OWNER_JIT_FAILED,
      targetType: "user",
      after: {
        email: normalized,
        reason: isNotFound ? "graph_not_found" : "graph_error",
        graphStatus: graphRes.status,
        graphErrorCode: graphRes.error?.code ?? null,
      },
    });
    if (isNotFound) {
      // Persistent negative cache — the UPN is not in the tenant; no
      // amount of retry will resolve it. Default owner sticks.
      ownerLookupCache.set(normalized, {
        userId: null,
        source: "default_owner",
      });
    }
    return getDefaultOwner();
  }

  // 4. Graph confirmed the user exists. JIT-provision.
  const graphUser = graphRes.data!;
  const provisioned = await jitProvisionD365Owner(
    normalized,
    graphUser,
    actorId,
  );
  ownerLookupCache.set(normalized, {
    userId: provisioned.userId,
    source: provisioned.source,
  });
  return provisioned;
}

/**
 * Idempotent JIT user provisioning. Caller has
 * already confirmed via Graph that the UPN exists; this helper
 * INSERTs the users row (or returns the existing one if a
 * concurrent caller beat us).
 */
export async function jitProvisionD365Owner(
  email: string,
  graphUser: GraphUserResponse,
  actorId: string,
): Promise<ResolvedOwner> {
  const normalized = email.trim().toLowerCase();

  // Idempotent — another concurrent caller may have just created.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing[0]) {
    return { userId: existing[0].id, source: "existing" };
  }

  const displayName =
    graphUser.displayName ||
    [graphUser.givenName, graphUser.surname]
      .filter((s): s is string => Boolean(s))
      .join(" ") ||
    normalized;
  const firstName = graphUser.givenName ?? displayName.split(" ")[0] ?? "";
  const lastName =
    graphUser.surname ??
    displayName.split(" ").slice(1).join(" ") ??
    "";
  const username = normalized; // username column matches email

  // INSERT with explicit JIT flags so admin can audit which users
  // came through this path. `is_active=false` mirrors the JIT user
  // shape — the user can sign in via Entra and the JWT callback
  // flips `is_active=true` on first successful auth.
  const inserted = await db
    .insert(users)
    .values({
      entraOid: graphUser.id,
      username,
      email: normalized,
      firstName: firstName || "Unknown",
      lastName: lastName || "User",
      displayName: displayName || normalized,
      isActive: false,
      jitProvisioned: true,
      jitProvisionedAt: sql`now()`,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  // If the INSERT raced and lost, re-select to get the winning row.
  let userId = inserted[0]?.id;
  if (!userId) {
    const winner = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);
    if (!winner[0]) {
      // unreachable per onConflictDoNothing semantics — surface as
      // an explicit error so the import halt fires.
      throw new Error(
        `D365 owner JIT INSERT raced and no winner row was found for ${normalized}`,
      );
    }
    userId = winner[0].id;
  }

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.OWNER_JIT_PROVISIONED,
    targetType: "user",
    targetId: userId,
    after: {
      email: normalized,
      displayName,
      entraOid: graphUser.id,
      source: "graph_jit",
    },
  });

  return { userId, source: "jit_provisioned" };
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
    // invariant: bootstrap-time config — the default-owner user
    // must exist in `users` before any D365 import runs. If we
    // reach here, the deployment was configured with a stale or
    // typo'd D365_DEFAULT_OWNER_EMAIL.
    throw new Error(
      `D365 default-owner '${defaultOwnerEmail}' not found in users table. Set D365_DEFAULT_OWNER_EMAIL to an existing user's email.`,
    );
  }
  return { userId: owner[0].id, source: "default_owner" };
}
