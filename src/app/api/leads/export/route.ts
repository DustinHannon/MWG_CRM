import { NextResponse, type NextRequest } from "next/server";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listLeads } from "@/lib/leads";
import { buildLeadsExport } from "@/lib/xlsx-import";
import { rateLimit } from "@/lib/security/rate-limit";

/**
 * Bound the export. Each call runs a filtered scan and builds an in-memory
 * workbook, so cap both the per-user rate and the total row count. The page
 * size must satisfy `leadFiltersSchema` (max 200) — passing a larger value
 * makes the whole filter object fail validation and silently fall back to
 * defaults (the pre-fix bug: an unfiltered first-50 export).
 */
const EXPORT_RATE_LIMIT_PER_MINUTE = 10;
const EXPORT_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 10_000;

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canExport) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rl = await rateLimit(
    { kind: "leads_export", principal: user.id },
    EXPORT_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // Respect the same filters as the /leads page. Page through the filtered
  // set in schema-valid chunks (listLeads caps pageSize at 200) up to a
  // hard ceiling, so the export reflects the user's actual filters instead
  // of silently truncating to a single unfiltered page.
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const collected: Awaited<ReturnType<typeof listLeads>>["rows"] = [];
  for (let page = 1; collected.length < MAX_EXPORT_ROWS; page++) {
    const result = await listLeads(
      user,
      { ...sp, pageSize: EXPORT_PAGE_SIZE, page },
      perms.canViewAllRecords,
    );
    collected.push(...result.rows);
    if (result.rows.length < EXPORT_PAGE_SIZE) break;
    if (collected.length >= result.total) break;
  }

  const rows = collected.slice(0, MAX_EXPORT_ROWS).map((l) => ({
    Salutation: l.salutation ?? "",
    "First Name": l.firstName,
    "Last Name": l.lastName,
    Email: l.email ?? "",
    Phone: l.phone ?? "",
    "Mobile Phone": l.mobilePhone ?? "",
    "Job Title": l.jobTitle ?? "",
    Company: l.companyName ?? "",
    City: l.city ?? "",
    State: l.state ?? "",
    Status: l.status,
    Rating: l.rating,
    Source: l.source,
    Owner: l.ownerDisplayName ?? "",
    "Estimated Value": l.estimatedValue ?? "",
    "Estimated Close Date": l.estimatedCloseDate ?? "",
    Tags: l.tags ? l.tags.join(", ") : "",
    "Created Via": l.createdVia ?? "",
    "Last Activity": l.lastActivityAt
      ? new Date(l.lastActivityAt).toISOString()
      : "",
    "Created At": new Date(l.createdAt).toISOString(),
    "Updated At": new Date(l.updatedAt).toISOString(),
  }));

  const buf = await buildLeadsExport(rows);
  return new NextResponse(new Uint8Array(buf) as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="mwg-crm-leads-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
