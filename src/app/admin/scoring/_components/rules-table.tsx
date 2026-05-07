"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  createScoringRuleAction,
  deleteScoringRuleAction,
  updateScoringRuleAction,
} from "../actions";

interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  predicate: object;
  points: number;
  isActive: boolean;
  version: number;
}

/**
 * Phase 5B — rules-list table for /admin/scoring.
 *
 * "Edit" opens an inline JSON editor for the predicate so admins can
 * change rules without a database round-trip. The full filter-builder UI
 * (matching the saved-views control) is deferred — admins can hand-edit
 * the JSON in the meantime, with the catalog in /admin/scoring/help.
 */
export function ScoringRulesTable({ rows }: { rows: RuleRow[] }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleRow | null>(null);
  const [creating, setCreating] = useState(false);

  function toggleActive(r: RuleRow) {
    startTransition(async () => {
      const res = await updateScoringRuleAction({
        id: r.id,
        isActive: !r.isActive,
        expectedVersion: r.version,
      });
      if (!res.ok) toast.error(res.error);
      else toast.success(r.isActive ? "Disabled" : "Enabled");
    });
  }

  function remove(r: RuleRow) {
    if (!confirm(`Delete rule "${r.name}"? This is irreversible.`)) return;
    startTransition(async () => {
      const res = await deleteScoringRuleAction(r.id);
      if (!res.ok) toast.error(res.error);
      else toast.success("Deleted");
    });
  }

  function save(d: RuleRow) {
    let predicate: object;
    try {
      predicate =
        typeof d.predicate === "string" ? JSON.parse(d.predicate) : d.predicate;
    } catch (err) {
      toast.error(
        "Predicate is not valid JSON: " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    startTransition(async () => {
      const res = await updateScoringRuleAction({
        id: d.id,
        name: d.name,
        description: d.description,
        predicate,
        points: d.points,
        isActive: d.isActive,
        expectedVersion: d.version,
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Saved");
        setEditing(null);
        setDraft(null);
      }
    });
  }

  function createNew(d: RuleRow) {
    let predicate: object;
    try {
      predicate =
        typeof d.predicate === "string" ? JSON.parse(d.predicate) : d.predicate;
    } catch (err) {
      toast.error(
        "Predicate is not valid JSON: " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    startTransition(async () => {
      const res = await createScoringRuleAction({
        name: d.name,
        description: d.description,
        predicate,
        points: d.points,
        isActive: d.isActive,
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Created");
        setCreating(false);
        setDraft(null);
      }
    });
  }

  return (
    <div className="mt-4">
      {rows.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          No rules yet. Create your first below.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-glass-border">
          <table className="data-table w-full text-sm">
            <thead className="bg-input/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-20">Active</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Predicate</th>
                <th className="px-3 py-2 text-right w-20">Points</th>
                <th className="px-3 py-2 w-32" />
              </tr>
            </thead>
            <tbody className="divide-y divide-glass-border">
              {rows.map((r) =>
                editing === r.id && draft ? (
                  <tr key={r.id} className="bg-primary/5">
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={draft.isActive}
                        onChange={(e) =>
                          setDraft({ ...draft, isActive: e.target.checked })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                        className="mb-1 w-full rounded border border-glass-border bg-input/40 px-2 py-1 text-sm"
                        placeholder="Rule name"
                      />
                      <input
                        type="text"
                        value={draft.description ?? ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            description: e.target.value || null,
                          })
                        }
                        className="w-full rounded border border-glass-border bg-input/40 px-2 py-1 text-xs text-muted-foreground"
                        placeholder="Description (optional)"
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <textarea
                        value={
                          typeof draft.predicate === "string"
                            ? draft.predicate
                            : JSON.stringify(draft.predicate, null, 2)
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            predicate: e.target.value as unknown as object,
                          })
                        }
                        rows={6}
                        className="w-full rounded border border-glass-border bg-input/40 px-2 py-1 font-mono text-xs"
                      />
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <input
                        type="number"
                        min={-100}
                        max={100}
                        value={draft.points}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            points: Number(e.target.value || 0),
                          })
                        }
                        className="w-20 rounded border border-glass-border bg-input/40 px-2 py-1 text-right text-sm"
                      />
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <button
                        onClick={() => save(draft)}
                        disabled={pending}
                        className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => {
                          setEditing(null);
                          setDraft(null);
                        }}
                        disabled={pending}
                        className="ml-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={r.isActive}
                        disabled={pending}
                        onChange={() => toggleActive(r)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium">{r.name}</p>
                      {r.description ? (
                        <p className="text-xs text-muted-foreground">
                          {r.description}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <code className="text-[11px] text-muted-foreground">
                        {summarisePredicate(r.predicate)}
                      </code>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span
                        className={
                          r.points > 0
                            ? "text-emerald-700 dark:text-emerald-300"
                            : r.points < 0
                              ? "text-rose-700 dark:text-rose-300"
                              : "text-muted-foreground"
                        }
                      >
                        {r.points > 0 ? `+${r.points}` : r.points}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => {
                          setEditing(r.id);
                          setDraft(r);
                        }}
                        disabled={pending}
                        className="rounded px-2 py-1 text-xs hover:bg-accent/40"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(r)}
                        disabled={pending}
                        className="ml-1 rounded px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {creating && draft ? (
        <CreateInline
          draft={draft}
          setDraft={setDraft}
          onCancel={() => {
            setCreating(false);
            setDraft(null);
          }}
          onSubmit={() => createNew(draft)}
          disabled={pending}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setDraft({
              id: "new",
              name: "",
              description: "",
              predicate: { all: [] },
              points: 10,
              isActive: true,
              version: 1,
            });
          }}
          className="mt-4 rounded-md border border-glass-border px-3 py-1.5 text-sm hover:bg-accent/30"
        >
          + New rule
        </button>
      )}
    </div>
  );
}

function summarisePredicate(p: object | string): string {
  try {
    const obj = typeof p === "string" ? JSON.parse(p) : p;
    const parts: string[] = [];
    type Clause = { field: string; op: string; value?: unknown };
    type P = { all?: Clause[]; any?: Clause[] };
    const o = obj as P;
    if (o.all && o.all.length > 0) {
      parts.push(
        o.all.map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value ?? null)}`).join(" AND "),
      );
    }
    if (o.any && o.any.length > 0) {
      parts.push(
        "(" +
          o.any
            .map((c) => `${c.field} ${c.op} ${JSON.stringify(c.value ?? null)}`)
            .join(" OR ") +
          ")",
      );
    }
    return parts.join(" AND ") || "(empty — matches nothing)";
  } catch {
    return "(invalid)";
  }
}

interface InlineProps {
  draft: RuleRow;
  setDraft: (r: RuleRow) => void;
  onCancel: () => void;
  onSubmit: () => void;
  disabled: boolean;
}

function CreateInline({
  draft,
  setDraft,
  onCancel,
  onSubmit,
  disabled,
}: InlineProps) {
  return (
    <div className="mt-4 rounded-lg border border-glass-border bg-primary/5 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        New rule
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Rule name *"
          className="rounded border border-glass-border bg-input/40 px-2 py-1.5 text-sm"
        />
        <input
          type="number"
          min={-100}
          max={100}
          value={draft.points}
          onChange={(e) =>
            setDraft({ ...draft, points: Number(e.target.value || 0) })
          }
          placeholder="Points"
          className="rounded border border-glass-border bg-input/40 px-2 py-1.5 text-sm"
        />
      </div>
      <input
        type="text"
        value={draft.description ?? ""}
        onChange={(e) =>
          setDraft({ ...draft, description: e.target.value || null })
        }
        placeholder="Description (optional)"
        className="mt-3 w-full rounded border border-glass-border bg-input/40 px-2 py-1.5 text-sm"
      />
      <textarea
        value={
          typeof draft.predicate === "string"
            ? draft.predicate
            : JSON.stringify(draft.predicate, null, 2)
        }
        onChange={(e) =>
          setDraft({ ...draft, predicate: e.target.value as unknown as object })
        }
        rows={6}
        placeholder='{"all":[{"field":"industry","op":"eq","value":"Insurance"}]}'
        className="mt-3 w-full rounded border border-glass-border bg-input/40 px-2 py-1.5 font-mono text-xs"
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
        />
        Active
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || draft.name.trim().length === 0}
          className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          Create rule
        </button>
      </div>
    </div>
  );
}
