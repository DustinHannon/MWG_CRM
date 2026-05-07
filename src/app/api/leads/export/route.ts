import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listLeads } from "@/lib/leads";
import { buildLeadsExport } from "@/lib/xlsx-import";

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canExport) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Respect the same filters as the /leads page.
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const result = await listLeads(
    user,
    { ...sp, pageSize: 10_000, page: 1 },
    perms.canViewAllLeads,
  );

  const rows = result.rows.map((l) => ({
    "First Name": l.firstName,
    "Last Name": l.lastName,
    Email: l.email ?? "",
    Phone: l.phone ?? "",
    Company: l.companyName ?? "",
    Status: l.status,
    Rating: l.rating,
    Source: l.source,
    Owner: l.ownerDisplayName ?? "",
    "Estimated Value": l.estimatedValue ?? "",
    Tags: l.tags ? l.tags.join(", ") : "",
    "Last Activity": l.lastActivityAt
      ? new Date(l.lastActivityAt).toISOString()
      : "",
    "Created At": new Date(l.createdAt).toISOString(),
  }));

  const buf = buildLeadsExport(rows);
  return new NextResponse(new Uint8Array(buf) as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="mwg-crm-leads-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
