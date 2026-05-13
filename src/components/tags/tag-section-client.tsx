"use client";

import { useState } from "react";
import { TagChip } from "./tag-chip";
import { TagEditModal } from "./tag-edit-modal";
import { TagInput } from "./tag-input";

interface TagSectionClientProps {
  entityType: "lead" | "account" | "contact" | "opportunity" | "task";
  entityId: string;
  initialTags: { id: string; name: string; color: string }[];
  canApply: boolean;
  canManage: boolean;
}

/**
 * Client-side state container for <TagSection>. Holds the current
 * chip list, opens the edit modal on chip click (governance), and
 * routes adds/removes through the inline action mode of <TagInput>.
 */
export function TagSectionClient({
  entityType,
  entityId,
  initialTags,
  canApply,
  canManage,
}: TagSectionClientProps) {
  const [tags, setTags] = useState(initialTags);
  const [editing, setEditing] = useState<
    { id: string; name: string; color: string } | null
  >(null);

  function onApplied(tag: { id: string; name: string; color: string }) {
    setTags((prev) =>
      prev.some((t) => t.id === tag.id) ? prev : [...prev, tag],
    );
  }
  function onRemoved(tagId: string) {
    setTags((prev) => prev.filter((t) => t.id !== tagId));
  }
  function onUpdated(next: { id: string; name: string; color: string }) {
    setTags((prev) => prev.map((t) => (t.id === next.id ? next : t)));
    setEditing(next);
  }
  function onDeleted(tagId: string) {
    setTags((prev) => prev.filter((t) => t.id !== tagId));
    setEditing(null);
  }

  // When neither permission is present, render the chips read-only.
  if (!canApply && !canManage) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 ? (
          <span className="text-xs text-muted-foreground">No tags.</span>
        ) : (
          tags.map((t) => <TagChip key={t.id} name={t.name} color={t.color} />)
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <TagInput
        mode="action"
        entityType={entityType}
        entityId={entityId}
        value={tags}
        disabled={!canApply}
        onApplied={onApplied}
        onRemoved={onRemoved}
        onTagClick={canManage ? (t) => setEditing(t) : undefined}
      />
      {editing ? (
        <TagEditModal
          tag={editing}
          open={Boolean(editing)}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}
