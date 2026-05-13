import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listTagsForEntity, type TagEntityType } from "@/lib/tags";
import { TagSectionClient } from "./tag-section-client";

interface TagSectionProps {
  entityType: TagEntityType;
  entityId: string;
  /** Optional pre-loaded tag list; falls back to a DB read. */
  appliedTags?: { id: string; name: string; color: string }[];
  /** Optional override for the section label. */
  label?: string;
}

/**
 * Server component that renders the Tags section on every entity
 * edit form. Reads the current user's permissions server-side so
 * the chips and combobox honour `canApplyTags` /
 * `canManageTagDefinitions` without trusting the client.
 *
 * When `appliedTags` isn't supplied, the section reads the join
 * table directly so callers don't have to thread the list through.
 */
export async function TagSection({
  entityType,
  entityId,
  appliedTags,
  label = "Tags",
}: TagSectionProps) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const canApply = user.isAdmin || perms.canApplyTags;
  const canManage = user.isAdmin || perms.canManageTagDefinitions;

  const initialTags =
    appliedTags ??
    (await listTagsForEntity(entityType, entityId)).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
    }));

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
      <TagSectionClient
        entityType={entityType}
        entityId={entityId}
        initialTags={initialTags}
        canApply={canApply}
        canManage={canManage}
      />
    </section>
  );
}
