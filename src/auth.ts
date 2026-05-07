import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { ensureBreakglass } from "@/lib/breakglass";
import { verifyPassword } from "@/lib/password";

/**
 * Auth.js v5 surface. Phase 2 wires only the Credentials provider for the
 * breakglass account. Phase 3 will add MicrosoftEntraID alongside it.
 *
 * Sessions are JWT-based (stateless cookie). We do NOT mount @auth/drizzle-
 * adapter because its expected user table shape (`name`, `emailVerified`,
 * `image`) doesn't match our schema (we use first_name / last_name /
 * display_name with custom Graph-driven provisioning per §7.3 of the brief).
 * In Phase 3 we'll write the Entra account row manually in the jwt callback
 * so we keep the refresh_token without the adapter's create-user pathway.
 */
const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(512),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  trustHost: true,
  providers: [
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

        // Bootstrap on first attempted sign-in. Idempotent.
        await ensureBreakglass();

        const candidate = await db
          .select()
          .from(users)
          .where(eq(users.username, username.toLowerCase()))
          .limit(1);
        const user = candidate[0];

        // The Credentials provider is breakglass-only — regular Entra users
        // can never sign in via password even if they exist.
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
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      // On initial sign-in (Credentials returns the user object), copy id onto
      // the token so server-side code can read session.user.id.
      if (user?.id) {
        token.userId = user.id;
      }

      // Refresh user-derived flags from DB on every JWT roundtrip when we have
      // a userId. This lets admins toggle is_active / is_admin / session_version
      // without users having to sign out and back in. Cheap query (PK lookup,
      // returns 5 columns).
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
        if (!row) {
          // User was deleted while session active. Force re-auth.
          return null;
        }
        if (!row.isActive) {
          return null;
        }
        if (
          typeof token.sessionVersion === "number" &&
          token.sessionVersion !== row.sessionVersion
        ) {
          // Admin bumped session_version → invalidate.
          return null;
        }
        token.isAdmin = row.isAdmin;
        token.sessionVersion = row.sessionVersion;
        token.displayName = row.displayName;
        token.email = row.email;
      } else if (token.userId && trigger === "signIn") {
        // First-mint: pull these once.
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
