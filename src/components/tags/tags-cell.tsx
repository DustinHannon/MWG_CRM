import { TagChip } from "./tag-chip";

/**
 * Cell renderer for the `tags` column on entity list tables.
 *
 * Renders up to `max` chips inline, wraps to a second line within a
 * fixed max-width, and falls back to "+N" for overflow. Designed to
 * sit inside a `<td>` without changing column width unpredictably.
 *
 * Accepts a uniform `{ id, name, color }` shape so the same component
 * works for leads / accounts / contacts / opportunities / tasks.
 */
export interface TagCellTag {
  id: string;
  name: string;
  color: string | null;
}

export function TagsCell({
  tags,
  max = 3,
}: {
  tags: TagCellTag[] | null | undefined;
  max?: number;
}) {
  if (!tags || tags.length === 0) {
    return <span className="text-muted-foreground/80">—</span>;
  }
  const visible = tags.slice(0, max);
  const overflow = tags.length - visible.length;
  return (
    <div className="flex max-w-[240px] flex-wrap items-center gap-1">
      {visible.map((t) => (
        <TagChip
          key={t.id}
          name={t.name}
          color={t.color ?? "slate"}
          size="sm"
        />
      ))}
      {overflow > 0 ? (
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          title={tags
            .slice(max)
            .map((t) => t.name)
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}
