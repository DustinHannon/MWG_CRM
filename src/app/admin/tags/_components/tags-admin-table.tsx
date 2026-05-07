"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { TagChip } from "@/components/tags/tag-chip";
import {
  deleteTagAction,
  updateTagAction,
} from "@/components/tags/actions";
import { TAG_COLORS } from "@/db/schema/tags";
import {
  formatUserTime,
  type TimePrefs,
} from "@/lib/format-time";

interface TagRow {
  id: string;
  name: string;
  slug: string;
  color: string;
  createdAt: Date;
  leadCount: number;
}

export function TagsAdminTable({
  rows,
  prefs,
}: {
  rows: TagRow[];
  prefs: TimePrefs;
}) {
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState(rows);

  function rename(id: string, name: string) {
    startTransition(async () => {
      const res = await updateTagAction({ id, name });
      if (res.ok) {
        toast.success("Renamed");
        setData((d) => d.map((t) => (t.id === id ? { ...t, name } : t)));
      } else {
        toast.error(res.error);
      }
    });
  }

  function recolor(id: string, color: string) {
    startTransition(async () => {
      const res = await updateTagAction({
        id,
        color: color as (typeof TAG_COLORS)[number],
      });
      if (res.ok) {
        toast.success("Color updated");
        setData((d) => d.map((t) => (t.id === id ? { ...t, color } : t)));
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove(id: string, name: string, leadCount: number) {
    if (
      !confirm(
        leadCount > 0
          ? `Delete "${name}"? It is currently applied to ${leadCount} lead(s). Those associations will be removed.`
          : `Delete "${name}"?`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await deleteTagAction(id);
      if (res.ok) {
        toast.success("Tag deleted");
        setData((d) => d.filter((t) => t.id !== id));
      } else {
        toast.error(res.error);
      }
    });
  }

  if (data.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        No tags yet. Tags appear here once any lead has been tagged.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full text-sm">
        <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Tag</th>
            <th className="px-4 py-3">Color</th>
            <th className="px-4 py-3">Leads</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-glass-border">
          {data.map((t) => (
            <tr key={t.id}>
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <TagChip name={t.name} color={t.color} />
                  <input
                    type="text"
                    defaultValue={t.name}
                    disabled={pending}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== t.name) rename(t.id, v);
                    }}
                    className="h-8 rounded border border-glass-border bg-input/60 px-2 text-sm"
                  />
                </div>
              </td>
              <td className="px-4 py-3">
                <select
                  defaultValue={t.color}
                  disabled={pending}
                  onChange={(e) => recolor(t.id, e.target.value)}
                  className="h-8 rounded border border-glass-border bg-input/60 px-2 text-sm"
                >
                  {TAG_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">
                {t.leadCount}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatUserTime(t.createdAt, prefs, "date")}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  onClick={() => remove(t.id, t.name, t.leadCount)}
                  disabled={pending}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
                >
                  <Trash2 size={12} aria-hidden />
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
