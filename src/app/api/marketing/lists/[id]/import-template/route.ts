import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingLists } from "@/db/schema/marketing-lists";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { buildStaticListImportTemplate } from "@/lib/marketing/lists/static-import-parse";

/**
 * Phase 29 §6 — Returns a minimal .xlsx template (header row only:
 * `email`, `name`) for the static-list import wizard.
 *
 * Access mirrors the import page: admin OR `canMarketingListsImport`
 * OR `canMarketingListsEdit` OR the list's creator. The list itself is
 * verified so we don't leak the template to users who can't see the
 * list.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await requireSession();

  const [list] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      listType: marketingLists.listType,
      createdById: marketingLists.createdById,
      isDeleted: marketingLists.isDeleted,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, id))
    .limit(1);
  if (!list || list.isDeleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (list.listType !== "static_imported") {
    return NextResponse.json(
      { error: "Template is only available for static-imported lists." },
      { status: 400 },
    );
  }

  const perms = await getPermissions(user.id);
  const isCreator = list.createdById === user.id;
  const allowed =
    user.isAdmin ||
    perms.canMarketingListsImport ||
    perms.canMarketingListsEdit ||
    perms.canManageMarketing ||
    isCreator;
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const buf = await buildStaticListImportTemplate();
  const body = new Uint8Array(buf);
  // Slugify list name so the download filename is safe across OSes.
  const slug = list.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const filename = `${slug || "static-list"}-import-template.xlsx`;
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
