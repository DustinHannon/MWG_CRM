import { sql } from "drizzle-orm";
import { db } from "@/db";
import { leadTags, tags } from "@/db/schema/tags";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { GlassCard } from "@/components/ui/glass-card";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { requireAdmin } from "@/lib/auth-helpers";
import { TagsAdminTable } from "./_components/tags-admin-table";

export const dynamic = "force-dynamic";

/**
 * /admin/tags — admin-only management of the first-class tags.
 * Edit name/color, delete (cascades to lead_tags). Lead counts shown
 * so admins can spot tags worth retiring.
 */
export default async function AdminTagsPage() {
  await requireAdmin();

  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      color: tags.color,
      createdAt: tags.createdAt,
      leadCount: sql<number>`(
        SELECT count(*)::int FROM lead_tags WHERE lead_tags.tag_id = ${tags.id}
      )`,
    })
    .from(tags)
    .orderBy(tags.name);

  // Touch leadTags so eslint won't complain about unused import in some configs.
  void leadTags;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Tags" },
        ]}
      />
      <StandardPageHeader
        kicker="Admin"
        title="Tags"
        fontFamily="display"
        description="First-class tags applied to leads. Editing name or color updates every lead the tag is on. Deleting cascades."
      />

      <GlassCard className="mt-6 p-0 overflow-hidden">
        <TagsAdminTable rows={rows} prefs={await getCurrentUserTimePrefs()} />
      </GlassCard>
    </div>
  );
}
