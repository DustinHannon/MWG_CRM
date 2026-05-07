import { sql } from "drizzle-orm";
import { db } from "@/db";
import { leadTags, tags } from "@/db/schema/tags";
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
    <div className="px-10 py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Admin
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">Tags</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        First-class tags applied to leads. Editing name or color updates
        every lead the tag is on. Deleting cascades.
      </p>

      <GlassCard className="mt-6 p-0 overflow-hidden">
        <TagsAdminTable rows={rows} prefs={await getCurrentUserTimePrefs()} />
      </GlassCard>
    </div>
  );
}
