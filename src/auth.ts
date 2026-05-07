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
 * Auth.js v5 surface. The MicrosoftEntraID provider is registered only when
 * AUTH_MICROSOFT_ENTRA_ID_ID + SECRET are set (i.e. after the App
 * Registration is created and the Vercel env vars are filled in). Until
 * then, only the breakglass Credentials provider is mounted, which keeps
 * the build green.
 *
 * Sessions are JWT-based. We don't mount @auth/drizzle-adapter — its
 * expected user table shape conflicts with our schema. Phase 3 writes the
 * `accounts` row manually via upsertAccount() so we keep the Microsoft
 * refresh_token across sessions.
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
     * For Entra OIDC sign-ins: provision the local user row + write the
     * account row + reject if domain is not allowed. We do this in `signIn`
     * (not `jwt`) because the user object passed to jwt() is shaped by the
     * provider — we want our own ProvisionedUser shape on the token.
     *
     * Returning false halts auth; throwing surfaces a user-readable error
     * via Auth.js.
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "microsoft-entra-id") {
        return true; // breakglass already validated by authorize()
      }
      if (!account.access_token) {
        console.error(
          "[auth] Entra sign-in missing access_token — likely scope/consent issue",
        );
        return "/auth/signin?error=missing_token";
      }

      const oidClaim =
        (profile as { oid?: string; sub?: string } | undefined)?.oid ??
        (profile as { oid?: string; sub?: string } | undefined)?.sub ??
        account.providerAccountId;

      const upn =
        (profile as { preferred_username?: string; upn?: string } | undefined)
          ?.preferred_username ??
        (profile as { preferred_username?: string; upn?: string } | undefined)
          ?.upn ??
        user.email ??
        "";
      const email = (user.email ?? upn).toLowerCase();

      try {
        const provisioned = await provisionEntraUser({
          entraOid: oidClaim,
          upn,
          email,
          accessToken: account.access_token,
        });

        if (!provisioned.isActive) {
          return "/auth/disabled";
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

        // Stash the resolved local user id on `user` so jwt() picks it up.
        user.id = provisioned.id;
        user.email = provisioned.email;
        user.name = provisioned.displayName;
        return true;
      } catch (err) {
        if (err instanceof EntraDomainNotAllowedError) {
          return `/auth/signin?error=domain_not_allowed`;
        }
        console.error("[auth] Entra signIn error", err);
        return "/auth/signin?error=signin_failed";
      }
    },

    async jwt({ token, user, account, trigger }) {
      // Initial mint: copy id from authorize() / signIn() result.
      if (user?.id) {
        token.userId = user.id;
      }

      // Persist Microsoft tokens onto the JWT for Phase 7 Graph calls.
      // The accounts table also has them — JWT is fine for fast access,
      // accounts table is the durable store (rotated on each refresh).
      if (account?.provider === "microsoft-entra-id") {
        token.msAccessToken = account.access_token;
        token.msRefreshToken = account.refresh_token;
        token.msExpiresAt = account.expires_at;
      }

      // On every roundtrip (except the very first sign-in), revalidate
      // active/admin/session_version against DB. Cheap PK lookup.
      if (token.userId && trigger !== "signIn") {
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
      } else if (token.userId && trigger === "signIn") {
        const fresh = await db
          .select({
            isAdmin: users.isAdmin,
            sessionVersion: users.sessionVersion,
            displayName: users.displayName,
          })
          .from(users)
          .where(eq(users.id, token.userId as string))
          .limit(1);
        const row = fresh[0];
        if (row) {
          token.isAdmin = row.isAdmin;
          token.sessionVersion = row.sessionVersion;
          token.displayName = row.displayName;
        }
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
