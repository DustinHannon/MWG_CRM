import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { requireSession } from "@/lib/auth-helpers";
import { checkMailboxKind } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Phase 15 — pre-flight endpoint for any UI surface that's about to ask the
 * user to schedule outbound email. Returns the cached `mailboxKind` when
 * available; otherwise hits Graph and persists the result.
 *
 * `?refresh=1` is admin-only and forces a fresh Graph probe even within
 * the 24h cache window — wired to the "Re-check mailbox" button on
 * /admin/users/[id].
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1" && session.isAdmin;

  const [u] = await db
    .select({
      userId: users.id,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (!u) {
    return NextResponse.json(
      { ok: false, kind: "unknown", message: "User not found" },
      { status: 404 },
    );
  }

  const result = await checkMailboxKind(u, { force });
  return NextResponse.json(result);
}
