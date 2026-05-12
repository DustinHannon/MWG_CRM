import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import type { SessionUser } from "@/lib/auth-helpers";
import type { AuthedKey } from "@/lib/api/auth";

/**
 * for endpoints that need a SessionUser-shaped subject (the
 * existing business-logic functions accept `user: SessionUser`), build
 * a synthetic identity from the API key's `created_by_id`.
 *
 * Decision: API keys act with the issuing user's permissions, but with
 * `canViewAll = true` so external integrations see all org records
 * regardless of which user created the key. Documented in the OpenAPI
 * description and on /apihelp.
 *
 * If the issuer is an admin, the synthetic SessionUser carries
 * `isAdmin: true`. Otherwise non-admin, but `canViewAll=true` is
 * passed explicitly to list functions so the org-wide visibility
 * holds either way.
 */
export async function sessionFromKey(key: AuthedKey): Promise<SessionUser> {
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      isActive: users.isActive,
      photoUrl: users.photoBlobUrl,
      jobTitle: users.jobTitle,
    })
    .from(users)
    .where(eq(users.id, key.createdById))
    .limit(1);
  if (!u) {
    // The key references a user that no longer exists. We can't act
    // safely on their behalf — synthesize a stub that fails closed.
    return {
      id: key.createdById,
      email: "deleted-user@invalid",
      displayName: "[Deleted User]",
      isAdmin: false,
      isActive: false,
      photoUrl: null,
      jobTitle: null,
    };
  }
  return u;
}
