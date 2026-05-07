import { NextResponse } from "next/server";
import { requireSession, getPermissions } from "@/lib/auth-helpers";
import { buildLeadImportTemplate } from "@/lib/xlsx-template";

export async function GET() {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canImport) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const buf = await buildLeadImportTemplate();
  const body = new Uint8Array(buf);
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="mwg-crm-leads-template.xlsx"',
    },
  });
}
