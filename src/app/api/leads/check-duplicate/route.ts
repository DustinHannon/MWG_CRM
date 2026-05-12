import { NextResponse } from "next/server";
import { and, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { eq } from "drizzle-orm";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { formatPersonName } from "@/lib/format/person-name";
import { withActive } from "@/lib/db/query-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * duplicate detection. GET ?email= and/or ?phone= returns up
 * to 10 likely duplicate leads. Permission-checked: non-admins without
 * canViewAllRecords only see their own owned leads.
 *
 * Match rules:
 * email: case-insensitive exact (strongest)
 * phone: digits-only normalised exact (strong)
 *
 * (firstName + lastName + companyName softer match isn't surfaced to
 * the API — handled inline in the manual create form when both email
 * and phone are blank.)
 */
export async function GET(req: Request) {
  const session = await requireSession();
  const url = new URL(req.url);
  const email = url.searchParams.get("email")?.trim() ?? "";
  const phone = url.searchParams.get("phone")?.trim() ?? "";

  if (email.length === 0 && phone.length === 0) {
    return NextResponse.json({ matches: [] });
  }

  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;

  const conditions = [];
  if (email.length > 0) {
    conditions.push(ilike(leads.email, email));
  }
  if (phone.length > 0) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length > 0) {
      // Normalise stored phone via regexp_replace to digits only.
      conditions.push(
        sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') = ${digits}`,
      );
      conditions.push(
        sql`regexp_replace(coalesce(${leads.mobilePhone}, ''), '\\D', '', 'g') = ${digits}`,
      );
    }
  }

  if (conditions.length === 0) {
    return NextResponse.json({ matches: [] });
  }

  // exclude archived leads from dedup. Pre-fix the check
  // surfaced soft-deleted rows as "duplicates" against fresh imports,
  // which the import flow then rejected, blocking re-creation of leads
  // whose archive was the actual user intent.
  const where = and(or(...conditions), withActive(leads.isDeleted));

  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      email: leads.email,
      phone: leads.phone,
      status: sql<string>`${leads.status}::text`,
      ownerName: users.displayName,
      ownerId: leads.ownerId,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(where)
    .limit(10);

  // Filter out leads the actor isn't allowed to see.
  const filtered = canViewAll
    ? rows
    : rows.filter((r) => r.ownerId === session.id);

  return NextResponse.json({
    matches: filtered.map((r) => ({
      id: r.id,
      name: formatPersonName(r),
      companyName: r.companyName,
      email: r.email,
      phone: r.phone,
      status: r.status,
      // surface ownerId so the warning UI can render the
      // canonical user chip instead of plain text.
      ownerId: r.ownerId,
      ownerName: r.ownerName,
    })),
  });
}
