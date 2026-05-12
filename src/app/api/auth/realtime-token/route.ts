import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { db } from "@/db";
import { permissions, users } from "@/db/schema/users";
import { requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * mints a Supabase Realtime JWT from the current session.
 *
 * The realtime client (browser) calls this endpoint on mount and again
 * before token expiry. The JWT is HS256-signed with the project's
 * SUPABASE_JWT_SECRET so the Realtime broker can verify it and apply
 * the RLS policies that read claims from `request.jwt.claims`.
 *
 * Claims:
 * sub user.id
 * role 'authenticated' (so RLS policies for that role apply)
 * is_admin user.isAdmin
 * can_view_all_records permission flag (admin always true)
 * email for client-side display only
 *
 * We re-fetch the user row from DB so a permission revocation takes
 * effect on the next refresh (≤ 1 hour after revoke).
 */
const JWT_TTL_SECONDS = 60 * 60; // 1 hour

// Per-process rate limit: 30 mints/min/user. Cold starts reset, which
// is fine because the realtime client only refreshes once per ~55min.
const MINT_LIMIT_WINDOW_MS = 60 * 1000;
const MINT_LIMIT = 30;
const mintAttempts = new Map<string, number[]>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - MINT_LIMIT_WINDOW_MS;
  const prev = (mintAttempts.get(userId) ?? []).filter((t) => t > cutoff);
  if (prev.length >= MINT_LIMIT) {
    mintAttempts.set(userId, prev);
    return false;
  }
  prev.push(now);
  mintAttempts.set(userId, prev);
  return true;
}

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();

  if (!env.SUPABASE_JWT_SECRET) {
    // Realtime not configured for this deployment. Returning 503 lets
    // the client retry rather than treating it as session-ended.
    return NextResponse.json(
      { error: "realtime-disabled" },
      { status: 503 },
    );
  }

  if (!checkRateLimit(session.id)) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429 },
    );
  }

  // Re-fetch latest is_active + permission flags so rotation/revocation
  // takes effect on next refresh.
  const fresh = await db
    .select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
      isAdmin: users.isAdmin,
      canViewAllRecords: permissions.canViewAllRecords,
    })
    .from(users)
    .leftJoin(permissions, eq(permissions.userId, users.id))
    .where(eq(users.id, session.id))
    .limit(1);

  const u = fresh[0];
  if (!u || !u.isActive) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  const token = await new SignJWT({
    role: "authenticated",
    is_admin: !!u.isAdmin,
    can_view_all_records: !!(u.isAdmin || u.canViewAllRecords),
    email: u.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(u.id)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(secret);

  logger.debug("realtime.token.minted", { userId: u.id });

  return NextResponse.json(
    { token, expiresIn: JWT_TTL_SECONDS },
    {
      headers: {
        // The token is sensitive — never cache.
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}
