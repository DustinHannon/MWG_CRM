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
import { verifyPassword } from "@/lib/password";

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
  session: { strategy: "jwt" },
  trustHost: true,
  providers,
  callbacks: {
    /**
     * Cheap pre-check only. Heavy work runs in jwt(). Returning a path here
     * triggers a redirect to that URL — useful for surfacing a friendly
     * error param. Returning false produces Auth.js's generic AccessDenied.
     */
    async signIn({ account, profile }) {
      if (account?.provider !== "microsoft-entra-id") return true;
      if (!account.access_token) {
        console.error("[auth] Entra sign-in missing access_token");
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
            console.warn(
              "[auth] entra sign-in for inactive user",
              provisioned.id,
            );
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

          token.userId = provisioned.id;
          token.isAdmin = provisioned.isAdmin;
          token.sessionVersion = provisioned.sessionVersion;
          token.displayName = provisioned.displayName;
          token.email = provisioned.email;

          // We intentionally do NOT store the Microsoft access/refresh
          // tokens on the JWT — they're large and would push the session
          // cookie into chunked-cookie territory. The accounts table is
          // authoritative for token state; Phase 7 reads from there.
          console.warn(
            `[auth] entra sign-in ok userId=${provisioned.id} email=${email}`,
          );
          return token;
        } catch (err) {
          if (err instanceof EntraDomainNotAllowedError) {
            console.warn("[auth] entra domain not allowed:", err.domain);
            return null;
          }
          console.error("[auth] entra jwt provisioning error", err);
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

      // Case 3: subsequent request — revalidate
      if (token.userId) {
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
        const row = fresh[0];
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
