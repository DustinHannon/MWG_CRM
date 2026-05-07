import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema/users";
import { env, MWG_TENANT_ID } from "@/lib/env";

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

async function loadAccount(userId: string): Promise<AccountTokens | null> {
  const row = await db
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

  const res = await fetch(
    `https://login.microsoftonline.com/${MWG_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
    },
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

  const refreshed = await refreshFromMicrosoft(acct.refreshToken);
  const newExpiresAt =
    Math.floor(Date.now() / 1000) + Math.max(60, refreshed.expires_in - 30);

  await db
    .update(accounts)
    .set({
      access_token: refreshed.access_token,
      // Microsoft sometimes rotates the refresh token, sometimes not.
      // Keep the existing one when the response omits it.
      refresh_token: refreshed.refresh_token ?? acct.refreshToken,
      expires_at: newExpiresAt,
      token_type: refreshed.token_type,
      scope: refreshed.scope,
    })
    .where(eq(accounts.providerAccountId, acct.providerAccountId));

  return refreshed.access_token;
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
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
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
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
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
