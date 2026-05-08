"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";
import {
  REPORT_ENTITIES,
  type EntityMeta,
  type FieldMeta,
} from "@/lib/reports/schemas";
import {
  REPORT_ENTITY_TYPES,
  REPORT_METRIC_FUNCTIONS,
  REPORT_VISUALIZATIONS,
  type ReportEntityType,
  type ReportMetric,
  type ReportMetricFunction,
  type ReportVisualization,
} from "@/db/schema/saved-reports";
import { GlassCard } from "@/components/ui/glass-card";
import { ReportRunner } from "./report-runner";

/**
 * Phase 11 — report builder client. Single page; sections gated by
 * entity selection. Live preview is debounced 300ms via the preview
 * API (the same executeReport path the saved runner uses).
 */

export interface ReportBuilderProps {
  /** Initial values when editing. */
  initial?: {
    id: string;
    name: string;
    description: string | null;
    entityType: ReportEntityType;
    fields: string[];
    filters: Record<string, FilterValue>;
    groupBy: string[];
    metrics: ReportMetric[];
    visualization: ReportVisualization;
    isShared: boolean;
  };
  mode: "create" | "edit";
}

type FilterOp = "eq" | "ilike" | "gte" | "lte" | "gt" | "lt" | "in";
type FilterValue = Partial<Record<FilterOp, unknown>>;
type FilterRow = {
  id: string;
  field: string;
  op: FilterOp;
  value: string;
};

interface PreviewState {
  loading: boolean;
  rows: Record<string, unknown>[];
  columns: string[];
  error: string | null;
}

export function ReportBuilder({ initial, mode }: ReportBuilderProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [entityType, setEntityType] = useState<ReportEntityType>(
    initial?.entityType ?? "lead",
  );
  const [fields, setFields] = useState<string[]>(initial?.fields ?? []);
  const [groupBy, setGroupBy] = useState<string[]>(initial?.groupBy ?? []);
  const [metrics, setMetrics] = useState<ReportMetric[]>(initial?.metrics ?? []);
  const [visualization, setVisualization] = useState<ReportVisualization>(
    initial?.visualization ?? "table",
  );
  const [isShared, setIsShared] = useState<boolean>(initial?.isShared ?? false);

  const [filterRows, setFilterRows] = useState<FilterRow[]>(
    () => filtersToRows(initial?.filters ?? {}),
  );

  const meta = REPORT_ENTITIES[entityType];

  // Reset entity-coupled fields when entity changes (except on first mount).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setFields([]);
    setGroupBy([]);
    setMetrics([]);
    setFilterRows([]);
  }, [entityType]);

  const filterPayload = useMemo(
    () => rowsToFilters(filterRows, meta),
    [filterRows, meta],
  );

  // Funnel availability rule: lead + group_by=['status']. Treat funnel
  // as a derived "effective visualization" so we don't have to write
  // back into state — keeps react-hooks/set-state-in-effect happy.
  const funnelEnabled =
    entityType === "lead" &&
    groupBy.length === 1 &&
    groupBy[0] === "status";
  const effectiveVisualization: ReportVisualization =
    !funnelEnabled && visualization === "funnel" ? "bar" : visualization;

  const definition = useMemo(
    () => ({
      name: name.trim() || "Untitled report",
      description: description.trim() || null,
      entityType,
      fields,
      filters: filterPayload,
      groupBy,
      metrics,
      visualization: effectiveVisualization,
      isShared,
    }),
    [
      name,
      description,
      entityType,
      fields,
      filterPayload,
      groupBy,
      metrics,
      effectiveVisualization,
      isShared,
    ],
  );

  const [preview, setPreview] = useState<PreviewState>({
    loading: false,
    rows: [],
    columns: [],
    error: null,
  });

  // Debounced live preview. setState inside the timeout (an external
  // event) keeps the effect compliant with react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      setPreview((p) => ({ ...p, loading: true }));
      try {
        const res = await fetch("/api/reports/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(definition),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!json.ok) {
          setPreview({
            loading: false,
            rows: [],
            columns: [],
            error: json.error ?? "Preview failed.",
          });
        } else {
          setPreview({
            loading: false,
            rows: json.data.rows ?? [],
            columns: json.data.columns ?? [],
            error: null,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setPreview({
          loading: false,
          rows: [],
          columns: [],
          error: err instanceof Error ? err.message : "Preview failed.",
        });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [definition]);

  const groupCount = groupBy.length;
  const showMetrics = groupCount > 0;

  async function save() {
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    const url =
      mode === "edit" && initial
        ? `/api/reports/${initial.id}`
        : "/api/reports";
    const method = mode === "edit" ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
    const json = await res.json();
    if (!json.ok) {
      toast.error(json.error ?? "Save failed.");
      return;
    }
    const id = mode === "edit" ? initial!.id : json.data.id;
    toast.success(mode === "edit" ? "Report updated." : "Report saved.");
    startTransition(() => router.push(`/reports/${id}`));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
      <div className="space-y-4">
        <Section title="Entity">
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as ReportEntityType)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {REPORT_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {REPORT_ENTITIES[t].label}
              </option>
            ))}
          </select>
        </Section>

        <Section title="Fields">
          <p className="mb-2 text-xs text-muted-foreground">
            Columns shown in the table view. Required when no group-by is set.
          </p>
          <div className="grid grid-cols-2 gap-1">
            {meta.fields.map((f) => (
              <label
                key={f.column}
                className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={fields.includes(f.column)}
                  onChange={(e) => {
                    setFields((prev) =>
                      e.target.checked
                        ? [...prev, f.column]
                        : prev.filter((x) => x !== f.column),
                    );
                  }}
                />
                <span className="truncate">{f.label}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Filters">
          <FilterBuilder
            meta={meta}
            rows={filterRows}
            onChange={setFilterRows}
          />
        </Section>

        <Section title="Group by">
          <p className="mb-2 text-xs text-muted-foreground">
            Up to 2 columns. Adding a group-by enables metrics + chart visualization.
          </p>
          <select
            multiple
            value={groupBy}
            onChange={(e) => {
              const selected = Array.from(
                e.target.selectedOptions,
                (o) => o.value,
              ).slice(0, 2);
              setGroupBy(selected);
            }}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            size={Math.min(6, meta.fields.length)}
          >
            {meta.fields.map((f) => (
              <option key={f.column} value={f.column}>
                {f.label}
              </option>
            ))}
          </select>
        </Section>

        {showMetrics ? (
          <Section title="Metrics">
            <MetricBuilder meta={meta} value={metrics} onChange={setMetrics} />
          </Section>
        ) : null}

        <Section title="Visualization">
          <div className="flex flex-wrap gap-2">
            {REPORT_VISUALIZATIONS.map((v) => {
              const disabled = v === "funnel" ? !funnelEnabled : false;
              return (
                <label
                  key={v}
                  className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm capitalize transition ${
                    visualization === v
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border bg-muted/30 text-foreground/80 hover:bg-muted"
                  } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name="vis"
                    value={v}
                    disabled={disabled}
                    checked={visualization === v}
                    onChange={() => setVisualization(v)}
                  />
                  {v}
                </label>
              );
            })}
          </div>
          {!funnelEnabled ? (
            <p className="mt-2 text-[11px] text-muted-foreground/80">
              Funnel is available when entity = Lead and group-by = status.
            </p>
          ) : null}
        </Section>

        <Section title="Save">
          <div className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Report name (required)"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isShared}
                onChange={(e) => setIsShared(e.target.checked)}
              />
              Share with team
            </label>
            <button
              type="button"
              onClick={save}
              disabled={pending || !name.trim()}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {mode === "edit" ? "Save changes" : "Save report"}
            </button>
          </div>
        </Section>
      </div>

      <div className="space-y-3">
        <GlassCard className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Live preview
            </h2>
            {preview.loading ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Running…
              </span>
            ) : null}
          </div>
          {preview.error ? (
            <p className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-200">
              {preview.error}
            </p>
          ) : (
            <ReportRunner
              visualization={effectiveVisualization}
              rows={preview.rows}
              columns={preview.columns}
              groupBy={groupBy}
              reportName={name || "preview"}
              hideExports
            />
          )}
        </GlassCard>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className="p-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </GlassCard>
  );
}

/* ---------- Filter builder ---------- */

function FilterBuilder({
  meta,
  rows,
  onChange,
}: {
  meta: EntityMeta;
  rows: FilterRow[];
  onChange: (rows: FilterRow[]) => void;
}) {
  function addRow() {
    const first = meta.fields[0];
    onChange([
      ...rows,
      {
        id: crypto.randomUUID(),
        field: first.column,
        op: defaultOp(first),
        value: "",
      },
    ]);
  }

  function patchRow(id: string, patch: Partial<FilterRow>) {
    onChange(
      rows.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        if (patch.field) {
          const f = meta.fields.find((x) => x.column === patch.field);
          if (f) next.op = defaultOp(f);
        }
        return next;
      }),
    );
  }

  function remove(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">
          No filters yet.
        </p>
      ) : null}
      {rows.map((r) => {
        const f = meta.fields.find((x) => x.column === r.field);
        const ops = opsForField(f);
        return (
          <div
            key={r.id}
            className="flex items-center gap-1 rounded-md border border-border bg-muted/20 p-1.5"
          >
            <select
              value={r.field}
              onChange={(e) => patchRow(r.id, { field: e.target.value })}
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
            >
              {meta.fields.map((mf) => (
                <option key={mf.column} value={mf.column}>
                  {mf.label}
                </option>
              ))}
            </select>
            <select
              value={r.op}
              onChange={(e) =>
                patchRow(r.id, { op: e.target.value as FilterOp })
              }
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
            >
              {ops.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </select>
            {f?.kind === "enum" ? (
              <select
                value={r.value}
                onChange={(e) => patchRow(r.id, { value: e.target.value })}
                className="flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs"
              >
                <option value="">—</option>
                {f.values?.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  f?.kind === "number"
                    ? "number"
                    : f?.kind === "date"
                      ? "date"
                      : "text"
                }
                value={r.value}
                onChange={(e) => patchRow(r.id, { value: e.target.value })}
                placeholder={r.op === "in" ? "comma,separated" : "value"}
                className="flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs"
              />
            )}
            <button
              type="button"
              onClick={() => remove(r.id)}
              className="rounded p-1 text-muted-foreground hover:bg-rose-500/15 hover:text-rose-600"
              aria-label="Remove filter"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30"
      >
        <Plus className="h-3 w-3" /> Add filter
      </button>
    </div>
  );
}

const OP_LABELS: Record<FilterOp, string> = {
  eq: "is",
  ilike: "contains",
  gte: "≥",
  lte: "≤",
  gt: ">",
  lt: "<",
  in: "in (csv)",
};

function defaultOp(f: FieldMeta): FilterOp {
  if (f.kind === "string") return "ilike";
  if (f.kind === "number") return "eq";
  if (f.kind === "date") return "gte";
  return "eq";
}

function opsForField(f: FieldMeta | undefined): FilterOp[] {
  if (!f) return ["eq"];
  switch (f.kind) {
    case "enum":
      return ["eq", "in"];
    case "string":
      return ["ilike", "eq"];
    case "uuid":
      return ["eq", "in"];
    case "number":
      return ["eq", "gte", "lte", "gt", "lt"];
    case "date":
      return ["gte", "lte"];
    default:
      return ["eq"];
  }
}

function rowsToFilters(
  rows: FilterRow[],
  meta: EntityMeta,
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  for (const r of rows) {
    const f = meta.fields.find((x) => x.column === r.field);
    if (!f) continue;
    if (r.value === "" && r.op !== "eq") continue;

    let coerced: unknown = r.value;
    if (f.kind === "number") {
      const n = Number(r.value);
      if (Number.isNaN(n)) continue;
      coerced = n;
    }

    if (r.op === "in") {
      const parts = String(r.value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) continue;
      out[r.field] = { ...(out[r.field] ?? {}), in: parts };
      continue;
    }

    out[r.field] = { ...(out[r.field] ?? {}), [r.op]: coerced };
  }
  return out;
}

function filtersToRows(
  filters: Record<string, FilterValue>,
): FilterRow[] {
  const rows: FilterRow[] = [];
  for (const [field, val] of Object.entries(filters)) {
    if (!val || typeof val !== "object") continue;
    for (const op of Object.keys(val) as FilterOp[]) {
      const v = (val as Record<string, unknown>)[op];
      const stringValue = Array.isArray(v) ? v.join(",") : String(v ?? "");
      rows.push({
        id: crypto.randomUUID(),
        field,
        op,
        value: stringValue,
      });
    }
  }
  return rows;
}

/* ---------- Metric builder ---------- */

function MetricBuilder({
  meta,
  value,
  onChange,
}: {
  meta: EntityMeta;
  value: ReportMetric[];
  onChange: (next: ReportMetric[]) => void;
}) {
  function addMetric() {
    onChange([
      ...value,
      { fn: "count", alias: nextAlias(value, "count") },
    ]);
  }
  function patch(i: number, m: Partial<ReportMetric>) {
    onChange(value.map((mm, idx) => (idx === i ? { ...mm, ...m } : mm)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  const numericFields = meta.fields.filter((f) => f.kind === "number");

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">
          No metrics yet. Add one to compute counts or sums.
        </p>
      ) : null}
      {value.map((m, i) => (
        <div
          key={i}
          className="flex items-center gap-1 rounded-md border border-border bg-muted/20 p-1.5"
        >
          <select
            value={m.fn}
            onChange={(e) =>
              patch(i, { fn: e.target.value as ReportMetricFunction })
            }
            className="rounded border border-border bg-background px-1.5 py-1 text-xs"
          >
            {REPORT_METRIC_FUNCTIONS.map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
          {m.fn !== "count" ? (
            <select
              value={m.field ?? ""}
              onChange={(e) =>
                patch(i, { field: e.target.value || undefined })
              }
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
            >
              <option value="">column…</option>
              {numericFields.map((f) => (
                <option key={f.column} value={f.column}>
                  {f.label}
                </option>
              ))}
            </select>
          ) : null}
          <input
            type="text"
            value={m.alias}
            onChange={(e) => patch(i, { alias: e.target.value })}
            placeholder="alias"
            className="flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded p-1 text-muted-foreground hover:bg-rose-500/15 hover:text-rose-600"
            aria-label="Remove metric"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addMetric}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border bg-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30"
      >
        <Plus className="h-3 w-3" /> Add metric
      </button>
    </div>
  );
}

function nextAlias(existing: ReportMetric[], base: string): string {
  if (!existing.some((m) => m.alias === base)) return base;
  let i = 2;
  while (existing.some((m) => m.alias === `${base}_${i}`)) i++;
  return `${base}_${i}`;
}
