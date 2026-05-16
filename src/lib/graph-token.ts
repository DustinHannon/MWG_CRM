import "server-only";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema/users";
import { env, MWG_TENANT_ID } from "@/lib/env";
import { fetchWithTimeout } from "@/lib/graph-fetch";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Tight abort bound for the Entra token-refresh POST when it runs
 * *inside* the per-user advisory-lock transaction (see
 * {@link getValidAccessTokenForUser}). The lock + the single pooled
 * connection (app client is `max:1`, STANDARDS §9.1) are held for the
 * whole Entra round-trip — that is required for H2 correctness (only
 * one in-flight refresh per user; dropping the lock across the call
 * re-opens the same-token double-POST clobber). Bounding the call at
 * 10s instead of the 30s default (`GRAPH_FETCH_TIMEOUT_MS`) caps the
 * worst-case connection+lock hold at 10s: a hung Entra response can no
 * longer pin the app's only pooled connection for 30s. A refresh-token
 * POST is one small request; Entra answers in ≤3s typically, so 10s is
 * generous and only trips a genuine stall.
 */
const TOKEN_REFRESH_IN_TX_TIMEOUT_MS = 10_000;

/**
 * Thrown when a stored refresh_token is no longer valid (revoked, expired,
 * tenant policy change). The UI catches this and shows a banner pointing
 * the user back to /api/auth/signin to re-consent.
 */
export class ReauthRequiredError extends Error {
  constructor(public reason: string) {
    super(`Microsoft session expired: ${reason}`);
    this.name = "ReauthRequiredError";
  }
}

interface AccountTokens {
  userId: string;
  providerAccountId: string;
  refreshToken: string | null;
  accessToken: string | null;
  expiresAt: number | null;
}

async function loadAccount(
  userId: string,
  conn: DbOrTx = db,
): Promise<AccountTokens | null> {
  const row = await conn
    .select({
      userId: accounts.userId,
      providerAccountId: accounts.providerAccountId,
      refreshToken: accounts.refresh_token,
      accessToken: accounts.access_token,
      expiresAt: accounts.expires_at,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, "microsoft-entra-id"),
      ),
    )
    .limit(1);
  return row[0] ?? null;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function refreshFromMicrosoft(
  refreshToken: string,
  timeoutMs: number,
): Promise<TokenResponse> {
  if (!env.AUTH_MICROSOFT_ENTRA_ID_ID || !env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    throw new ReauthRequiredError("Entra credentials not configured on server");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.AUTH_MICROSOFT_ENTRA_ID_ID,
    client_secret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    refresh_token: refreshToken,
    scope: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.Read",
      "Mail.Send",
      "Mail.ReadWrite",
      "Calendars.Read",
      "Calendars.ReadWrite",
    ].join(" "),
  });

  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${MWG_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    },
    timeoutMs,
  );

  if (!res.ok) {
    const body = await res.text();
    // 400 invalid_grant means the refresh token is no longer valid.
    throw new ReauthRequiredError(
      `Microsoft token refresh failed (${res.status}): ${body.slice(0, 240)}`,
    );
  }

  return (await res.json()) as TokenResponse;
}

/**
 * Returns a valid Graph access token for `userId`, refreshing it if it's
 * within 60 seconds of expiring. Persists the new tokens on the accounts
 * row. Throws ReauthRequiredError if no valid refresh path exists.
 */
export async function getValidAccessTokenForUser(
  userId: string,
): Promise<string> {
  const acct = await loadAccount(userId);
  if (!acct) {
    throw new ReauthRequiredError("No Microsoft account linked to this user");
  }
  if (!acct.refreshToken && !acct.accessToken) {
    throw new ReauthRequiredError("No tokens stored");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isFresh =
    acct.accessToken && acct.expiresAt && acct.expiresAt > nowSec + 60;

  if (isFresh && acct.accessToken) return acct.accessToken;

  if (!acct.refreshToken) {
    throw new ReauthRequiredError(
      "Access token expired and no refresh token stored",
    );
  }

  // Serialize the refresh-token read-modify-write per user. Without this,
  // two concurrent sends with an expired token both POST the SAME stored
  // refresh_token to Entra; rotation invalidates one, the racing UPDATEs
  // clobber each other, and a valid rotated refresh_token is lost — forcing
  // the user to re-consent. A DB-level lock (not in-process) is required:
  // Vercel runs multiple lambda instances.
  //
  // pg_advisory_xact_lock is transaction-scoped and auto-releases at tx
  // end — the Supavisor-safe form (STANDARDS §9.2 forbids SESSION-scoped
  // advisory locks under the pooler; §19.8.2 sanctions xact-scoped locks
  // inside an explicit transaction).
  //
  // The Entra refresh POST runs INSIDE this locked tx by necessity, not
  // convenience: H2 correctness requires exactly one in-flight refresh
  // per user. The d365 `pull-batch` precedent keeps its HTTP call OUTSIDE
  // the lock because its work is idempotent-by-cursor and a double-fetch
  // is harmless; a double token-refresh is NOT — Entra rotation makes the
  // second POST invalidate the first request's freshly-issued token.
  // Dropping the lock across the call (lock→release→HTTP→re-lock→persist)
  // would let two requests pass the freshness check and both POST the same
  // refresh_token — the exact clobber this guards. So the lock must span
  // the call. The starvation risk that creates (the app client is `max:1`,
  // STANDARDS §9.1 — this tx pins the only pooled connection for the
  // round-trip) is bounded by passing TOKEN_REFRESH_IN_TX_TIMEOUT_MS:
  // a hung Entra response aborts in 10s, not the 30s default, so it can
  // never hold the connection+lock unbounded.
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`graph-refresh:${userId}`}))`,
    );

    // Double-checked locking: another request may have refreshed while we
    // waited on the lock. Re-load inside the lock and bail if now fresh.
    const fresh = await loadAccount(userId, tx);
    if (!fresh) {
      throw new ReauthRequiredError("No Microsoft account linked to this user");
    }
    const nowSec2 = Math.floor(Date.now() / 1000);
    if (
      fresh.accessToken &&
      fresh.expiresAt &&
      fresh.expiresAt > nowSec2 + 60
    ) {
      return fresh.accessToken;
    }
    if (!fresh.refreshToken) {
      throw new ReauthRequiredError(
        "Access token expired and no refresh token stored",
      );
    }

    const refreshed = await refreshFromMicrosoft(
      fresh.refreshToken,
      TOKEN_REFRESH_IN_TX_TIMEOUT_MS,
    );
    const newExpiresAt =
      Math.floor(Date.now() / 1000) + Math.max(60, refreshed.expires_in - 30);

    await tx
      .update(accounts)
      .set({
        access_token: refreshed.access_token,
        // Microsoft sometimes rotates the refresh token, sometimes not.
        // Keep the existing one when the response omits it.
        refresh_token: refreshed.refresh_token ?? fresh.refreshToken,
        expires_at: newExpiresAt,
        token_type: refreshed.token_type,
        scope: refreshed.scope,
      })
      .where(eq(accounts.providerAccountId, fresh.providerAccountId));

    return refreshed.access_token;
  });
}

/**
 * Convenience: fetch a Graph endpoint with the user's delegated token,
 * refreshing automatically if needed.
 */
export async function graphFetchAs<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getValidAccessTokenForUser(userId);
  const res = await fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new GraphRequestError(res.status, body, path);
  }
  return res.json() as Promise<T>;
}

/**
 * Same as graphFetchAs but returns a binary Response (for /me/photo/$value).
 */
export async function graphFetchBinaryAs(
  userId: string,
  path: string,
): Promise<Response> {
  const token = await getValidAccessTokenForUser(userId);
  return fetchWithTimeout(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export class GraphRequestError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Graph ${status} on ${path}: ${body.slice(0, 240)}`);
    this.name = "GraphRequestError";
  }
}
