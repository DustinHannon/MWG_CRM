import "server-only";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { ensureBreakglass } from "@/lib/breakglass";
import {
  EntraDomainNotAllowedError,
  provisionEntraUser,
  upsertAccount,
} from "@/lib/entra-provisioning";
import { entraConfigured, env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { verifyPassword } from "@/lib/password";
import { refreshUserPhotoIfStale } from "@/lib/graph-photo";

/**
 * Auth.js v5 surface. The MicrosoftEntraID provider registers only when
 * AUTH_MICROSOFT_ENTRA_ID_ID + SECRET are set. Until then only the
 * breakglass Credentials provider is mounted.
 *
 * Sessions are JWT. We don't mount @auth/drizzle-adapter because its
 * expected user shape conflicts with our schema. The Entra account row
 * (refresh_token, access_token, expires_at) is upserted manually inside
 * the jwt() callback when a fresh OAuth account arrives.
 *
 * Why provisioning lives in jwt() and not signIn(): mutating `user` inside
 * signIn() does NOT reliably propagate to jwt() in Auth.js v5. Doing the
 * work in jwt() lets us write `token.userId` directly, which is what the
 * session callback ultimately reads.
 */
const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(512),
});

/* ---------------------------------------------------------------------------
 * In-memory rate limit for breakglass authorize().
 *
 * Per-process map of username → recent timestamps. On every authorize() we
 * trim the bucket to the last 15 minutes and check that there are <5 entries
 * before recording a new one. Returns false (deny) when over the cap.
 *
 * Intentionally simple — Vercel cold starts reset the counter, which is
 * fine because breakglass usage is rare. For higher-volume creds endpoints
 * upgrade to Upstash Redis with a sliding window.
 * ------------------------------------------------------------------------- */
const BREAKGLASS_WINDOW_MS = 15 * 60 * 1000;
const BREAKGLASS_MAX_ATTEMPTS = 5;
const breakglassAttempts = new Map<string, number[]>();

function checkBreakglassRateLimit(username: string): boolean {
  const now = Date.now();
  const cutoff = now - BREAKGLASS_WINDOW_MS;
  const prev = (breakglassAttempts.get(username) ?? []).filter((t) => t > cutoff);
  if (prev.length >= BREAKGLASS_MAX_ATTEMPTS) {
    breakglassAttempts.set(username, prev);
    return false;
  }
  prev.push(now);
  breakglassAttempts.set(username, prev);
  return true;
}

const providers: Provider[] = [
  Credentials({
    id: "breakglass",
    name: "Breakglass",
    credentials: {
      username: { label: "Username", type: "text" },
      password: { label: "Password", type: "password" },
    },
    async authorize(rawCreds) {
      const parsed = credentialsSchema.safeParse(rawCreds);
      if (!parsed.success) return null;
      const { username, password } = parsed.data;

      // Lightweight per-username rate limit: 5 attempts / 15 minutes.
      // Breakglass is a brute-force target — non-Entra credential. The
      // store is in-memory and per-process, so cold starts reset the
      // counter — this is acceptable because breakglass usage is rare.
      // If breakglass usage spikes, swap for Upstash Redis (TODO).
      if (!checkBreakglassRateLimit(username.toLowerCase())) {
        logger.warn("breakglass.rate_limited", {
          username: username.toLowerCase(),
        });
        return null;
      }

      await ensureBreakglass();

      const candidate = await db
        .select()
        .from(users)
        .where(eq(users.username, username.toLowerCase()))
        .limit(1);
      const user = candidate[0];

      if (!user || !user.isBreakglass || !user.isActive || !user.passwordHash) {
        return null;
      }

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) return null;

      return {
        id: user.id,
        email: user.email,
        name: user.displayName,
      };
    },
  }),
];

if (entraConfigured) {
  providers.push(
    MicrosoftEntraID({
      clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: {
        params: {
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
        },
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // 24-hour session lifetime is conservative for an internal CRM. The
  // jwt callback re-validates against the DB on every request anyway, so
  // a deactivated user is signed out within one request roundtrip — but a
  // forgotten device is bounded to a day.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 },
  trustHost: true,
  providers,
  callbacks: {
    /**
     * Phase 11 — explicit open-redirect guard. Auth.js v5's default
     * redirect callback already validates same-origin, but having this
     * be implicit means a future custom `redirect` could silently widen
     * the policy. Centralising the rule here (and in
     * `lib/auth-redirect.ts`) protects against that drift.
     */
    async redirect({ url, baseUrl }) {
      const { safeRedirect } = await import("@/lib/auth-redirect");
      return safeRedirect(url, baseUrl);
    },
    /**
     * Cheap pre-check only. Heavy work runs in jwt(). Returning a path here
     * triggers a redirect to that URL — useful for surfacing a friendly
     * error param. Returning false produces Auth.js's generic AccessDenied.
     */
    async signIn({ account, profile }) {
      if (account?.provider !== "microsoft-entra-id") return true;
      if (!account.access_token) {
        logger.error("auth.entra_missing_access_token");
        return "/auth/signin?error=missing_token";
      }

      // Domain check happens here so we redirect away cleanly without
      // doing any DB writes for unauthorised domains.
      const claims = profile as
        | { preferred_username?: string; upn?: string; email?: string }
        | undefined;
      const upn = claims?.preferred_username ?? claims?.upn ?? claims?.email ?? "";
      const email = (claims?.email ?? upn).toLowerCase();
      const domain = email.split("@")[1]?.toLowerCase();
      if (!domain || !env.ALLOWED_EMAIL_DOMAINS.includes(domain)) {
        return "/auth/signin?error=domain_not_allowed";
      }
      return true;
    },

    /**
     * Single source of truth for token state.
     *
     * Three cases:
     *   1. Initial Entra sign-in (account.provider === microsoft-entra-id):
     *      provision the local user, upsert the accounts row, mint token.
     *   2. Initial breakglass sign-in (user.id present, no account):
     *      copy user.id onto token, hydrate from DB.
     *   3. Subsequent requests (no user, no account): revalidate is_active /
     *      session_version against DB; refresh display_name/email.
     */
    async jwt({ token, user, account, profile, trigger }) {
      // Case 1: Entra initial mint
      if (account?.provider === "microsoft-entra-id" && account.access_token) {
        try {
          const claims = profile as
            | {
                oid?: string;
                sub?: string;
                preferred_username?: string;
                upn?: string;
                email?: string;
              }
            | undefined;
          const oidClaim =
            claims?.oid ?? claims?.sub ?? account.providerAccountId;
          const upn =
            claims?.preferred_username ??
            claims?.upn ??
            user?.email ??
            claims?.email ??
            "";
          const email = (user?.email ?? claims?.email ?? upn).toLowerCase();

          const provisioned = await provisionEntraUser({
            entraOid: oidClaim,
            upn,
            email,
            accessToken: account.access_token,
          });

          if (!provisioned.isActive) {
            logger.warn("auth.entra_inactive_user", {
              userId: provisioned.id,
            });
            return null;
          }

          await upsertAccount({
            userId: provisioned.id,
            providerAccountId: account.providerAccountId,
            refreshToken: account.refresh_token,
            accessToken: account.access_token,
            expiresAt: account.expires_at ?? null,
            tokenType: account.token_type,
            scope: account.scope,
            idToken: account.id_token,
          });

          // Phase 5A — refresh the cached Microsoft profile photo if it's
          // older than 24h (or never set). The function swallows its own
          // errors so a transient Graph hiccup never blocks sign-in; we
          // wrap in another try/catch as a belt-and-braces guard against
          // anything sneaking out.
          try {
            await refreshUserPhotoIfStale(provisioned.id);
          } catch (err) {
            logger.warn("auth.photo_refresh_failed", {
              userId: provisioned.id,
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }

          token.userId = provisioned.id;
          token.isAdmin = provisioned.isAdmin;
          token.sessionVersion = provisioned.sessionVersion;
          token.displayName = provisioned.displayName;
          token.email = provisioned.email;

          // We intentionally do NOT store the Microsoft access/refresh
          // tokens on the JWT — they're large and would push the session
          // cookie into chunked-cookie territory. The accounts table is
          // authoritative for token state; Phase 7 reads from there.
          logger.info("auth.entra_signin_ok", {
            userId: provisioned.id,
            email,
          });
          return token;
        } catch (err) {
          if (err instanceof EntraDomainNotAllowedError) {
            logger.warn("auth.entra_domain_not_allowed", {
              domain: err.domain,
            });
            return null;
          }
          logger.error("auth.entra_provisioning_failed", {
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }

      // Case 2: Credentials (breakglass) initial mint
      if (user?.id && trigger === "signIn") {
        token.userId = user.id;
        const fresh = await db
          .select({
            isAdmin: users.isAdmin,
            sessionVersion: users.sessionVersion,
            displayName: users.displayName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);
        const row = fresh[0];
        if (row) {
          token.isAdmin = row.isAdmin;
          token.sessionVersion = row.sessionVersion;
          token.displayName = row.displayName;
          token.email = row.email;
        }
        return token;
      }

      // Case 3: subsequent request — revalidate.
      //
      // A transient DB blip here would otherwise sign the user out (the
      // jwt callback returning null clears the session). We retry once
      // on error, and if the retry also fails we KEEP the existing token
      // — better to let the user keep working with slightly-stale session
      // facts than to log them out on a hiccup. Inactive / version-mismatch
      // checks remain hard-failing because those represent a deliberate
      // admin decision.
      if (token.userId) {
        let row: {
          isActive: boolean;
          isAdmin: boolean;
          sessionVersion: number;
          displayName: string;
          email: string;
        } | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const fresh = await db
              .select({
                isActive: users.isActive,
                isAdmin: users.isAdmin,
                sessionVersion: users.sessionVersion,
                displayName: users.displayName,
                email: users.email,
              })
              .from(users)
              .where(eq(users.id, token.userId as string))
              .limit(1);
            row = fresh[0] ?? null;
            break;
          } catch (err) {
            logger.warn("auth.jwt_revalidate_query_failed", {
              attempt: attempt + 1,
              maxAttempts: 2,
              errorMessage: err instanceof Error ? err.message : String(err),
            });
            if (attempt === 1) {
              // Both attempts failed — return the existing token as-is.
              return token;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        if (!row) return null;
        if (!row.isActive) return null;
        if (
          typeof token.sessionVersion === "number" &&
          token.sessionVersion !== row.sessionVersion
        ) {
          return null;
        }
        token.isAdmin = row.isAdmin;
        token.sessionVersion = row.sessionVersion;
        token.displayName = row.displayName;
        token.email = row.email;
      }

      return token;
    },

    async session({ session, token }) {
      if (token?.userId) {
        session.user.id = token.userId as string;
        session.user.isAdmin = Boolean(token.isAdmin);
        session.user.sessionVersion = Number(token.sessionVersion ?? 0);
        if (token.displayName) {
          session.user.name = String(token.displayName);
        }
        if (token.email) {
          session.user.email = String(token.email);
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
});
