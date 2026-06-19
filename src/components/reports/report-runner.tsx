"use client";

import Link from "next/link";
import { useMemo } from "react";
import { StandardEmptyState } from "@/components/standard";
import type { ReportVisualization } from "@/db/schema/saved-reports";
import { neutralizeSpreadsheetFormula } from "@/lib/exports/formula-guard";
import { formatCurrency } from "@/lib/format/currency";
import { isNumericKind, type FieldKind } from "@/lib/reports/schemas";
import { cn } from "@/lib/utils";
import { ReportChart, type ChartDatum } from "./report-charts";

/**
 * client-side runner. Receives precomputed rows from a
 * server component (saved-report page) and renders the appropriate
 * visualization plus a flat data table.
 *
 * Export PDF links to /reports-print/[id]; CSV is generated client
 * side as a Blob and downloaded.
 */
export interface ReportRunnerProps {
  reportId?: string;
  visualization: ReportVisualization;
  rows: Record<string, unknown>[];
  columns: string[];
  groupBy: string[];
  /** Stable display name used as the CSV filename. */
  reportName: string;
  /** Optional metric labels for chart legends. */
  metricLabels?: { primary?: string; secondary?: string };
  /**
   * Output-column -> field kind. Drives money formatting: cells whose
   * column kind is "currency" render through `formatCurrency`. Built
   * by `buildReportColumnKinds`. Absent column => default formatting.
   */
  columnKinds?: Record<string, FieldKind>;
  /** Hide export buttons (used by builder preview). */
  hideExports?: boolean;
}

export function ReportRunner({
  reportId,
  visualization,
  rows,
  columns,
  groupBy,
  reportName,
  metricLabels,
  columnKinds,
  hideExports = false,
}: ReportRunnerProps) {
  const chartData = useMemo<ChartDatum[]>(() => {
    if (groupBy.length === 0) return [];
    if (rows.length === 0) return [];

    // Identify which numeric column to use as "value": prefer the first
    // metric column (anything not in groupBy). Fall back to count.
    const metricCols = columns.filter((c) => !groupBy.includes(c));
    const primary = metricCols[0];
    const secondary = metricCols[1];

    return rows.map((r) => {
      const labelParts = groupBy.map((g) => String(r[g] ?? "—"));
      const datum: ChartDatum = {
        name: labelParts.join(" / "),
        value: toNumber(r[primary ?? ""]) ?? 0,
      };
      if (secondary) datum.value2 = toNumber(r[secondary]) ?? 0;
      return datum;
    });
  }, [rows, columns, groupBy]);

  const showChart = visualization !== "table" && groupBy.length > 0;

  return (
    <div className="space-y-6">
      {!hideExports ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {reportId ? (
            <Link
              href={`/reports-print/${reportId}`}
              target="_blank"
              rel="noopener"
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted"
            >
              Export PDF
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => downloadCsv(reportName, columns, rows)}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm transition hover:bg-muted"
          >
            Export CSV
          </button>
        </div>
      ) : null}

      {showChart ? (
        <ReportChart
          data={chartData}
          visualization={visualization}
          primaryLabel={metricLabels?.primary}
          secondaryLabel={metricLabels?.secondary}
        />
      ) : null}

      <DataTable rows={rows} columns={columns} columnKinds={columnKinds} />
    </div>
  );
}

function DataTable({
  rows,
  columns,
  columnKinds,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  columnKinds?: Record<string, FieldKind>;
}) {
  if (rows.length === 0) {
    return (
      <StandardEmptyState
        title="No rows match this report"
        description="Adjust the report's filters or date range, then re-run."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            {columns.map((c) => {
              const kind = columnKinds?.[c];
              const numeric = kind ? isNumericKind(kind) : false;
              return (
                <th
                  key={c}
                  className={cn(
                    "px-3 py-2 text-left font-medium text-foreground",
                    numeric && "text-right tabular-nums",
                  )}
                >
                  {humanize(c)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-muted/20">
              {columns.map((c) => {
                const kind = columnKinds?.[c];
                const numeric = kind ? isNumericKind(kind) : false;
                return (
                  <td
                    key={c}
                    className={cn(
                      "px-3 py-2 align-top text-foreground/90",
                      numeric && "text-right tabular-nums",
                    )}
                  >
                    {formatCell(r[c], kind)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function humanize(s: string): string {
  return s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCell(v: unknown, kind?: FieldKind): string {
  if (v === null || v === undefined) return "—";
  // Money columns (kind="currency", incl. sum/avg/min/max over one)
  // render through the canonical formatter. postgres-js returns
  // numeric columns as strings, so accept string or number here.
  if (kind === "currency" && (typeof v === "string" || typeof v === "number")) {
    return formatCurrency(v);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    // crude ISO-date detection
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      try {
        return new Date(v).toISOString().slice(0, 16).replace("T", " ");
      } catch {
        return v;
      }
    }
    return v;
  }
  if (typeof v === "number") return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function downloadCsv(
  name: string,
  columns: string[],
  rows: Record<string, unknown>[],
) {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const raw = val instanceof Date ? val.toISOString() : String(val);
    // Stop a cell like `=cmd|...` executing when the CSV is opened.
    const s = neutralizeSpreadsheetFormula(raw);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replaceAll('"', '""')}"`;
    }
    return s;
  };
  const lines = [
    columns.map(escape).join(","),
    ...rows.map((r) => columns.map((c) => escape(r[c])).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(name)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "report"
  );
}
