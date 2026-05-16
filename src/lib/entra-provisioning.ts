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
  type GraphMeProfileExtended,
  type GraphManager,
} from "@/lib/graph";

/**
 * Entra OIDC user provisioning per the brief §7.3.
 *
 * Resolution order:
 * 1. Lookup by entra_oid (the OIDC `oid` claim — stable across name changes).
 * 2. Fallback: lookup by email.
 * 3. Create a new row, parsing UPN naively, then OVERRIDING with Graph
 * /me's givenName / surname / displayName. We deliberately do NOT
 * import phone, department, company, jobTitle from Graph.
 *
 * On returning sign-ins we refresh display_name/first_name/last_name/email
 * from Graph, but never touch is_admin, is_active, or permissions.
 *
 * The resolution-order + insert body lives in
 * {@link createOrUpdateUserFromEntraProfile}, which takes a normalized,
 * transport-agnostic {@link NormalizedEntraProfile}. Interactive SSO (this
 * function) and a future admin bulk-sync wizard both create users through
 * that single core so the two paths cannot drift.
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
   * set on the first-ever sign-in for the user. The /welcome
   * server component reads this column directly (not from the JWT) and
   * redirects to /leads if it's older than 5 minutes, so we don't need
   * to plumb a "first login" flag onto the token.
   */
  firstLoginAt: Date | null;
}

/**
 * One normalized, transport-agnostic shape that both create paths feed into.
 * Interactive SSO builds this from a delegated /me + /me/manager fetch; the
 * admin bulk-sync wizard builds it from a directory /users row. Whatever the
 * source, the create-core only ever sees this.
 */
export interface NormalizedEntraProfile {
  entraOid: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  /**
   * Full sign-in UPN (userPrincipalName), recorded verbatim in the
   * `user.create.jit` audit `after` payload. Kept distinct from
   * `username` (the UPN local part) so the forensic audit row stays
   * byte-identical to the legacy JIT behaviour.
   */
  upn: string;
  /**
   * false → do not write any of the Entra profile columns (job_title,
   * department, office_location, business_phones, mobile_phone, country,
   * entra_synced_at). Mirrors the legacy `if (me)` guard: when the
   * delegated /me fetch failed we must NOT overwrite a returning user's
   * existing profile with nulls, nor stamp entra_synced_at. Directory
   * sync always has the row, so it sets this true.
   */
  profileTouched: boolean;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  businessPhones?: string[];
  mobilePhone?: string | null;
  country?: string | null;
  /** false → do not write any manager_* column (transient/unknown). */
  managerTouched: boolean;
  managerEntraOid: string | null;
  managerDisplayName: string | null;
  managerEmail: string | null;
}

/**
 * Microsoft Graph `/users` (directory) row shape (subset). Declared here so
 * the future directory-sync module imports it from this module rather than
 * the reverse, avoiding an import cycle (directory-sync → entra-provisioning,
 * never back).
 */
export interface GraphDirectoryUser {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  country?: string | null;
  mobilePhone?: string | null;
  businessPhones?: string[] | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  assignedLicenses?: Array<{ skuId?: string | null }> | null;
}

/** Result of the shared create-core. `created` distinguishes insert vs update. */
export interface ProvisionCoreResult {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isAdmin: boolean;
  sessionVersion: number;
  firstLoginAt: Date | null;
  created: boolean;
}

export async function provisionEntraUser(
  input: ProvisionInput,
): Promise<ProvisionedUser> {
  // Domain allowlist — never let an account through that doesn't belong.
  const domain = (input.email || input.upn).split("@")[1]?.toLowerCase();
  if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    throw new EntraDomainNotAllowedError(domain ?? "(missing)");
  }

  // extended /me fetch. We pull job_title, department, office,
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

  // /me/manager. 404 means "no manager set" — null those fields.
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

  // Compute name/email exactly as before: naive UPN parse, overridden by
  // Graph /me's givenName/surname/displayName when present.
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

  // Map the manager tri-state onto the normalized profile's manager fields:
  //   fresh      → touched, fields from the resolved manager (or all null)
  //   no_manager → touched, all manager fields explicitly null (Graph 404)
  //   error      → NOT touched, so the core writes no manager_* columns
  let managerTouched: boolean;
  let managerEntraOid: string | null = null;
  let managerDisplayName: string | null = null;
  let managerEmail: string | null = null;
  if (managerState.kind === "fresh") {
    managerTouched = true;
    managerEntraOid = managerState.manager?.id ?? null;
    managerDisplayName = managerState.manager?.displayName ?? null;
    managerEmail =
      managerState.manager?.mail ??
      managerState.manager?.userPrincipalName ??
      null;
  } else if (managerState.kind === "no_manager") {
    managerTouched = true;
  } else {
    managerTouched = false;
  }

  const profile: NormalizedEntraProfile = {
    entraOid: input.entraOid,
    username: naive.username,
    upn: input.upn,
    email,
    firstName,
    lastName,
    displayName,
    // Mirror the legacy `if (me)` guard: only carry profile fields when
    // the /me fetch succeeded; otherwise the core skips those columns and
    // a returning user's existing profile is preserved.
    profileTouched: me !== null,
    jobTitle: me ? (me.jobTitle ?? null) : undefined,
    department: me ? (me.department ?? null) : undefined,
    officeLocation: me ? (me.officeLocation ?? null) : undefined,
    businessPhones: me ? (me.businessPhones ?? []) : undefined,
    mobilePhone: me ? (me.mobilePhone ?? null) : undefined,
    country: me ? (me.country ?? null) : undefined,
    managerTouched,
    managerEntraOid,
    managerDisplayName,
    managerEmail,
  };

  const r = await createOrUpdateUserFromEntraProfile(profile, {
    source: "entra_sso",
  });

  return {
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isActive: r.isActive,
    isAdmin: r.isAdmin,
    sessionVersion: r.sessionVersion,
    firstLoginAt: r.firstLoginAt,
  };
}

/**
 * Build a normalized profile from a Microsoft Graph directory (`/users`) row.
 * Reuses the same UPN parsing / trim-or-fallback rules as the interactive
 * path so a bulk-synced user resolves identically to a JIT one.
 *
 * The directory `/users` payload does not expand `manager`, so manager
 * fields are left untouched (`managerTouched: false`); a separate
 * `/users/{id}/manager` pass would set them.
 */
export function normalizeDirectoryUserToProfile(
  u: GraphDirectoryUser,
): NormalizedEntraProfile {
  const upn = (u.userPrincipalName ?? u.mail ?? "").toLowerCase();
  const naive = parseUpn(upn);
  const firstName = trimOrFallback(u.givenName, naive.firstName);
  const lastName = trimOrFallback(u.surname, naive.lastName);
  const displayName = trimOrFallback(
    u.displayName,
    `${firstName} ${lastName}`.trim(),
  );
  const email = trimOrFallback(u.mail, upn).toLowerCase();

  return {
    entraOid: u.id,
    username: naive.username,
    // Full UPN preserved verbatim for the create audit (parity with the
    // JIT path, which records the raw id_token UPN).
    upn: u.userPrincipalName ?? u.mail ?? "",
    email,
    firstName,
    lastName,
    displayName,
    // A directory /users row always carries the profile fields.
    profileTouched: true,
    jobTitle: u.jobTitle ?? null,
    department: u.department ?? null,
    officeLocation: u.officeLocation ?? null,
    businessPhones: u.businessPhones ?? [],
    mobilePhone: u.mobilePhone ?? null,
    country: u.country ?? null,
    managerTouched: false,
    managerEntraOid: null,
    managerDisplayName: null,
    managerEmail: null,
  };
}

/**
 * The shared user create-core: resolution order (entra_oid → email → insert)
 * plus default permissions, preferences, audit, and admin notification. Both
 * interactive SSO and the admin bulk-sync wizard call this so they cannot
 * drift.
 *
 * `opts.source`:
 *  - "entra_sso": the person is signing in now, so we bump login timestamps
 *    (first_login_at backfill, last_login_at) and on insert set
 *    first_login_at / last_login_at = now().
 *  - "admin_sync": the person has NOT logged in (admin pre-provisioning), so
 *    we set NO login timestamps — but still mark jit_provisioned/-At because
 *    the origin is the Entra identity directory; this keeps the admin
 *    "Recently joined" filter accurate.
 */
export async function createOrUpdateUserFromEntraProfile(
  profile: NormalizedEntraProfile,
  opts: { source: "entra_sso" | "admin_sync" },
): Promise<ProvisionCoreResult> {
  // Profile-field patch. Only when profile data is present
  // (profileTouched) write the profile columns + stamp entra_synced_at;
  // only when the caller resolved the manager (managerTouched) write the
  // manager_* columns. When neither is touched the patch is empty, so a
  // returning user's existing profile/manager is preserved on update —
  // critical for the degraded path where the Graph /me fetch failed.
  const profilePatch: Record<string, unknown> = {};
  if (profile.profileTouched) {
    profilePatch.jobTitle = profile.jobTitle ?? null;
    profilePatch.department = profile.department ?? null;
    profilePatch.officeLocation = profile.officeLocation ?? null;
    profilePatch.businessPhones = profile.businessPhones ?? [];
    profilePatch.mobilePhone = profile.mobilePhone ?? null;
    profilePatch.country = profile.country ?? null;
    profilePatch.entraSyncedAt = new Date();
  }
  if (profile.managerTouched) {
    profilePatch.managerEntraOid = profile.managerEntraOid;
    profilePatch.managerDisplayName = profile.managerDisplayName;
    profilePatch.managerEmail = profile.managerEmail;
  }

  // Only interactive sign-in bumps login telemetry. Admin pre-provisioning
  // never touches first/last login (the person has not logged in).
  const bumpLogin = opts.source === "entra_sso";

  // Find existing by entra_oid first. Single SELECT, fast.
  const byOid = await db
    .select()
    .from(users)
    .where(eq(users.entraOid, profile.entraOid))
    .limit(1);

  if (byOid[0]) {
    const existing = byOid[0];
    // one-time backfill of first_login_at for users that
    // pre-date the JIT telemetry columns. Only set when null; never
    // overwritten on subsequent sign-ins. Only on an interactive sign-in.
    const needsFirstLoginBackfill =
      bumpLogin && existing.firstLoginAt === null;
    // Refresh user-derived facts. Never overwrite admin/active/perms.
    await db
      .update(users)
      .set({
        firstName: profile.firstName,
        lastName: profile.lastName,
        displayName: profile.displayName,
        email: profile.email,
        ...profilePatch,
        ...(needsFirstLoginBackfill ? { firstLoginAt: sql`now()` } : {}),
        ...(bumpLogin ? { lastLoginAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, existing.id));

    return {
      id: existing.id,
      email: profile.email,
      displayName: profile.displayName,
      isActive: existing.isActive,
      isAdmin: existing.isAdmin,
      sessionVersion: existing.sessionVersion,
      // If we just backfilled, surface "now" so callers don't see a stale
      // null. Otherwise return the persisted value (may be null on legacy
      // rows we chose not to backfill — but the branch above always does
      // when bumpLogin). admin_sync never bumps → returns existing value.
      firstLoginAt: needsFirstLoginBackfill
        ? new Date()
        : existing.firstLoginAt,
      created: false,
    };
  }

  // Fall back to email match (e.g. user existed before SSO, or oid changed).
  const byEmail = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

  if (byEmail[0]) {
    const existing = byEmail[0];
    const needsFirstLoginBackfill =
      bumpLogin && existing.firstLoginAt === null;
    await db
      .update(users)
      .set({
        entraOid: profile.entraOid,
        firstName: profile.firstName,
        lastName: profile.lastName,
        displayName: profile.displayName,
        ...profilePatch,
        ...(needsFirstLoginBackfill ? { firstLoginAt: sql`now()` } : {}),
        ...(bumpLogin ? { lastLoginAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email: profile.email,
      displayName: profile.displayName,
      isActive: existing.isActive,
      isAdmin: existing.isAdmin,
      sessionVersion: existing.sessionVersion,
      firstLoginAt: needsFirstLoginBackfill
        ? new Date()
        : existing.firstLoginAt,
      created: false,
    };
  }

  // Create new. Default permissions per §7.3.
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({
        entraOid: profile.entraOid,
        username: profile.username,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        displayName: profile.displayName,
        isBreakglass: false,
        isAdmin: false,
        isActive: true,
        ...profilePatch,
        // JIT telemetry. `jit_provisioned` flags rows created from the
        // Entra identity directory (vs manually-seeded breakglass /
        // fixtures); the timestamps power the admin "Recently joined"
        // filter and the /welcome page's 5-minute first-login window.
        // Set for BOTH sources — admin pre-provisioning still originates
        // from Entra — but the login timestamps below are
        // interactive-only.
        jitProvisioned: true,
        jitProvisionedAt: sql`now()`,
        ...(bumpLogin
          ? { firstLoginAt: sql`now()`, lastLoginAt: sql`now()` }
          : {}),
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

    // every user gets a preferences row on provisioning. Idempotent
    // ON CONFLICT so a backfilled row from migration time stays put.
    // New users default to dark theme; ON CONFLICT DO NOTHING means an
    // existing user re-authing keeps whatever theme they chose.
    await tx
      .insert(userPreferences)
      .values({ userId: row.id, theme: "dark" })
      .onConflictDoNothing({ target: userPreferences.userId });

    return row;
  });

  // JIT telemetry (post-commit). Audit + admin bell notification
  // run AFTER the transaction so a notification fan-out failure can never
  // leave a half-provisioned user. Both helpers swallow their own errors.
  await writeAudit({
    actorId: created.id,
    actorEmailSnapshot: profile.email,
    action: "user.create.jit",
    targetType: "user",
    targetId: created.id,
    after: { upn: profile.upn, email: profile.email, source: opts.source },
  });
  // Interactive SSO (JIT) notifies admins per first-login — correct at
  // one-at-a-time scale. Admin bulk sync would flood the bell with one
  // per user; commitEntraUserImport emits a single run summary instead.
  if (opts.source !== "admin_sync") {
    await notifyAdminsOfNewUser({
      userId: created.id,
      displayName: profile.displayName,
      email: profile.email,
    });
  }

  return {
    id: created.id,
    email: profile.email,
    displayName: profile.displayName,
    isActive: created.isActive,
    isAdmin: created.isAdmin,
    sessionVersion: created.sessionVersion,
    // We just inserted the row; on an interactive sign-in firstLoginAt is
    // "now" (the DB-side now() would be more precise but this is only used
    // for a 5-minute window check, so the < 100ms drift is irrelevant).
    // Admin pre-provisioning set no login timestamp → null.
    firstLoginAt: bumpLogin ? new Date() : null,
    created: true,
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
