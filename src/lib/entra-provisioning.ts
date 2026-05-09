import "server-only";
import { logger } from "@/lib/logger";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users, accounts } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { notifyAdminsOfNewUser } from "@/lib/notifications";
import {
  graphFetchWithToken,
  GraphError,
  type GraphMeProfile,
  type GraphMeProfileExtended,
  type GraphManager,
} from "@/lib/graph";

/**
 * Entra OIDC user provisioning per the brief §7.3.
 *
 * Resolution order:
 *   1. Lookup by entra_oid (the OIDC `oid` claim — stable across name changes).
 *   2. Fallback: lookup by email.
 *   3. Create a new row, parsing UPN naively, then OVERRIDING with Graph
 *      /me's givenName / surname / displayName. We deliberately do NOT
 *      import phone, department, company, jobTitle from Graph.
 *
 * On returning sign-ins we refresh display_name/first_name/last_name/email
 * from Graph, but never touch is_admin, is_active, or permissions.
 */
export interface ProvisionInput {
  entraOid: string;
  upn: string; // userPrincipalName from id_token (e.g. "dustin.hannon@morganwhite.com")
  email: string; // best-effort email (mail || preferred_username)
  accessToken: string;
}

export interface ProvisionedUser {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  sessionVersion: number;
  /**
   * Phase 15 — set on the first-ever sign-in for the user. The /welcome
   * server component reads this column directly (not from the JWT) and
   * redirects to /leads if it's older than 5 minutes, so we don't need
   * to plumb a "first login" flag onto the token.
   */
  firstLoginAt: Date | null;
}

export async function provisionEntraUser(
  input: ProvisionInput,
): Promise<ProvisionedUser> {
  // Domain allowlist — never let an account through that doesn't belong.
  const domain = (input.email || input.upn).split("@")[1]?.toLowerCase();
  if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    throw new EntraDomainNotAllowedError(domain ?? "(missing)");
  }

  // Phase 3B: extended /me fetch. We pull job_title, department, office,
  // business_phones, mobile_phone, country alongside the original
  // name/email fields for the /settings page. If the call fails (e.g.
  // consent missing), we fall back to the parsed UPN — better degraded
  // than fully blocked.
  let me: GraphMeProfileExtended | null = null;
  try {
    me = await graphFetchWithToken<GraphMeProfileExtended>(
      input.accessToken,
      "/me?$select=id,givenName,surname,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,mobilePhone,country",
    );
  } catch (err) {
    logger.warn("entra.me_lookup_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 3B: /me/manager. 404 means "no manager set" — null those fields.
  // Other errors leave existing values alone (don't overwrite on transient
  // failures).
  type ManagerState =
    | { kind: "fresh"; manager: GraphManager | null }
    | { kind: "no_manager" }
    | { kind: "error" };
  let managerState: ManagerState = { kind: "error" };
  try {
    const manager = await graphFetchWithToken<GraphManager>(
      input.accessToken,
      "/me/manager?$select=id,displayName,mail,userPrincipalName",
    );
    managerState = { kind: "fresh", manager };
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) {
      managerState = { kind: "no_manager" };
    } else {
      logger.warn("entra.manager_lookup_failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const naive = parseUpn(input.upn);
  const firstName = trimOrFallback(me?.givenName, naive.firstName);
  const lastName = trimOrFallback(me?.surname, naive.lastName);
  const displayName = trimOrFallback(
    me?.displayName,
    `${firstName} ${lastName}`.trim(),
  );
  const email = trimOrFallback(
    me?.mail,
    trimOrFallback(input.email, input.upn),
  ).toLowerCase();

  // Find existing by entra_oid first. Single SELECT, fast.
  const byOid = await db
    .select()
    .from(users)
    .where(eq(users.entraOid, input.entraOid))
    .limit(1);

  if (byOid[0]) {
    const existing = byOid[0];
    // Phase 15 — one-time backfill of first_login_at for users that
    // pre-date the JIT telemetry columns. Only set when null; never
    // overwritten on subsequent sign-ins.
    const needsFirstLoginBackfill = existing.firstLoginAt === null;
    // Refresh user-derived facts. Never overwrite admin/active/perms.
    await db
      .update(users)
      .set({
        firstName,
        lastName,
        displayName,
        email,
        ...buildEntraProfilePatch(me, managerState),
        ...(needsFirstLoginBackfill ? { firstLoginAt: sql`now()` } : {}),
        lastLoginAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, existing.id));

    return {
      id: existing.id,
      email,
      displayName,
      isActive: existing.isActive,
      isAdmin: existing.isAdmin,
      sessionVersion: existing.sessionVersion,
      // If we just backfilled, surface "now" so callers don't see a stale
      // null. Otherwise return the persisted value (may be null on legacy
      // rows we chose not to backfill — but the branch above always does).
      firstLoginAt: needsFirstLoginBackfill ? new Date() : existing.firstLoginAt,
    };
  }

  // Fall back to email match (e.g. user existed before SSO, or oid changed).
  const byEmail = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (byEmail[0]) {
    const existing = byEmail[0];
    const needsFirstLoginBackfill = existing.firstLoginAt === null;
    await db
      .update(users)
      .set({
        entraOid: input.entraOid,
        firstName,
        lastName,
        displayName,
        ...buildEntraProfilePatch(me, managerState),
        ...(needsFirstLoginBackfill ? { firstLoginAt: sql`now()` } : {}),
        lastLoginAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email,
      displayName,
      isActive: existing.isActive,
      isAdmin: existing.isAdmin,
      sessionVersion: existing.sessionVersion,
      firstLoginAt: needsFirstLoginBackfill ? new Date() : existing.firstLoginAt,
    };
  }

  // Create new. Default permissions per §7.3.
  const username = naive.username;
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({
        entraOid: input.entraOid,
        username,
        email,
        firstName,
        lastName,
        displayName,
        isBreakglass: false,
        isAdmin: false,
        isActive: true,
        ...buildEntraProfilePatch(me, managerState),
        // Phase 15 — JIT telemetry. `jit_provisioned` flags rows created
        // by SSO (vs manually-seeded breakglass / fixtures); the
        // timestamps power the admin "Recently joined" filter and the
        // /welcome page's 5-minute first-login window.
        jitProvisioned: true,
        jitProvisionedAt: sql`now()`,
        firstLoginAt: sql`now()`,
        lastLoginAt: sql`now()`,
      })
      .returning({
        id: users.id,
        isActive: users.isActive,
        isAdmin: users.isAdmin,
        sessionVersion: users.sessionVersion,
      });
    const row = inserted[0];

    await tx.insert(permissions).values({
      userId: row.id,
      // 2026-05-08: new Entra users default to org-wide visibility so
      // they can see every lead in the system on first login. Existing
      // users keep whatever flag is already on their permissions row;
      // this only affects rows newly inserted by this provisioning
      // path. Flip back to false here if MWG ever wants the
      // mine-only default again.
      canViewAllRecords: true,
      canCreateLeads: true,
      canEditLeads: true,
      canDeleteLeads: false,
      canImport: false,
      canExport: false,
      canSendEmail: true,
      canViewReports: true,
    });

    // Phase 2D: every user gets a preferences row on provisioning. Idempotent
    // ON CONFLICT so a backfilled row from migration time stays put.
    await tx
      .insert(userPreferences)
      .values({ userId: row.id })
      .onConflictDoNothing({ target: userPreferences.userId });

    return row;
  });

  // Phase 15 — JIT telemetry (post-commit). Audit + admin bell notification
  // run AFTER the transaction so a notification fan-out failure can never
  // leave a half-provisioned user. Both helpers swallow their own errors.
  await writeAudit({
    actorId: created.id,
    actorEmailSnapshot: email,
    action: "user.create.jit",
    targetType: "user",
    targetId: created.id,
    after: { upn: input.upn, email, source: "entra_sso" },
  });
  await notifyAdminsOfNewUser({
    userId: created.id,
    displayName,
    email,
  });

  return {
    id: created.id,
    email,
    displayName,
    isActive: created.isActive,
    isAdmin: created.isAdmin,
    sessionVersion: created.sessionVersion,
    // We just inserted the row; firstLoginAt is "now". The DB-side
    // `now()` would be more precise but this is only used for a 5-minute
    // window check, so the < 100ms drift is irrelevant.
    firstLoginAt: new Date(),
  };
}

/**
 * Persist the OIDC account row (refresh_token + access_token + expires_at).
 * We don't use the @auth/drizzle-adapter; this is the manual equivalent of
 * what its `linkAccount` does on initial sign-in.
 */
export async function upsertAccount(args: {
  userId: string;
  providerAccountId: string;
  refreshToken?: string | null;
  accessToken?: string | null;
  expiresAt?: number | null;
  tokenType?: string | null;
  scope?: string | null;
  idToken?: string | null;
}): Promise<void> {
  const existing = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.providerAccountId, args.providerAccountId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(accounts)
      .set({
        refresh_token: args.refreshToken ?? null,
        access_token: args.accessToken ?? null,
        expires_at: args.expiresAt ?? null,
        token_type: args.tokenType ?? null,
        scope: args.scope ?? null,
        id_token: args.idToken ?? null,
      })
      .where(eq(accounts.providerAccountId, args.providerAccountId));
    return;
  }

  await db.insert(accounts).values({
    userId: args.userId,
    type: "oidc",
    provider: "microsoft-entra-id",
    providerAccountId: args.providerAccountId,
    refresh_token: args.refreshToken ?? null,
    access_token: args.accessToken ?? null,
    expires_at: args.expiresAt ?? null,
    token_type: args.tokenType ?? null,
    scope: args.scope ?? null,
    id_token: args.idToken ?? null,
  });
}

export class EntraDomainNotAllowedError extends Error {
  constructor(public domain: string) {
    super(`Email domain not allowed: ${domain}`);
    this.name = "EntraDomainNotAllowedError";
  }
}

function parseUpn(upn: string): {
  username: string;
  firstName: string;
  lastName: string;
} {
  const local = upn.split("@")[0]?.toLowerCase() ?? upn.toLowerCase();
  const username = local;
  const parts = local.split(".").filter(Boolean);
  const cap = (s: string) =>
    s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  return {
    username,
    firstName: cap(parts[0] ?? ""),
    lastName: cap(parts.slice(1).join(" ").trim()),
  };
}

function trimOrFallback(
  candidate: string | null | undefined,
  fallback: string,
): string {
  const c = candidate?.trim();
  return c && c.length > 0 ? c : fallback;
}

/**
 * Phase 3B: build the patch for Entra-sourced profile fields. Always sets
 * entra_synced_at when we have any profile data. Manager fields:
 *   - "fresh"      → set to manager's data (or null all if manager is null)
 *   - "no_manager" → null all manager fields (Graph 404 = no manager set)
 *   - "error"      → don't touch manager fields (transient failure)
 */
function buildEntraProfilePatch(
  me: GraphMeProfileExtended | null,
  managerState:
    | { kind: "fresh"; manager: GraphManager | null }
    | { kind: "no_manager" }
    | { kind: "error" },
): Partial<{
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhones: string[];
  mobilePhone: string | null;
  country: string | null;
  managerEntraOid: string | null;
  managerDisplayName: string | null;
  managerEmail: string | null;
  entraSyncedAt: Date;
}> {
  const patch: Record<string, unknown> = {};
  if (me) {
    patch.jobTitle = me.jobTitle ?? null;
    patch.department = me.department ?? null;
    patch.officeLocation = me.officeLocation ?? null;
    patch.businessPhones = me.businessPhones ?? [];
    patch.mobilePhone = me.mobilePhone ?? null;
    patch.country = me.country ?? null;
    patch.entraSyncedAt = new Date();
  }
  if (managerState.kind === "fresh") {
    patch.managerEntraOid = managerState.manager?.id ?? null;
    patch.managerDisplayName = managerState.manager?.displayName ?? null;
    patch.managerEmail =
      managerState.manager?.mail ?? managerState.manager?.userPrincipalName ?? null;
  } else if (managerState.kind === "no_manager") {
    patch.managerEntraOid = null;
    patch.managerDisplayName = null;
    patch.managerEmail = null;
  }
  // "error" → leave manager_* fields alone.
  return patch as ReturnType<typeof buildEntraProfilePatch>;
}
