import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { permissions, users, accounts } from "@/db/schema/users";
import { userPreferences } from "@/db/schema/views";
import { env } from "@/lib/env";
import { graphFetchWithToken, type GraphMeProfile } from "@/lib/graph";

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
}

export async function provisionEntraUser(
  input: ProvisionInput,
): Promise<ProvisionedUser> {
  // Domain allowlist — never let an account through that doesn't belong.
  const domain = (input.email || input.upn).split("@")[1]?.toLowerCase();
  if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    throw new EntraDomainNotAllowedError(domain ?? "(missing)");
  }

  // Phase 3 calls /me here. If the call fails (e.g. consent missing), we
  // fall back to the parsed UPN — better degraded than fully blocked.
  let me: GraphMeProfile | null = null;
  try {
    me = await graphFetchWithToken<GraphMeProfile>(
      input.accessToken,
      "/me?$select=id,givenName,surname,displayName,mail,userPrincipalName",
    );
  } catch (err) {
    console.warn(
      "[entra] /me lookup failed during provisioning — using UPN-derived names",
      err instanceof Error ? err.message : err,
    );
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
    // Refresh user-derived facts. Never overwrite admin/active/perms.
    await db
      .update(users)
      .set({
        firstName,
        lastName,
        displayName,
        email,
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
    await db
      .update(users)
      .set({
        entraOid: input.entraOid,
        firstName,
        lastName,
        displayName,
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
      canViewAllLeads: false,
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

  return {
    id: created.id,
    email,
    displayName,
    isActive: created.isActive,
    isAdmin: created.isAdmin,
    sessionVersion: created.sessionVersion,
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
