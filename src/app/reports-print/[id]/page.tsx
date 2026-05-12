import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-helpers";
import { UserTime } from "@/components/ui/user-time";
import {
  assertCanViewReport,
  executeReport,
} from "@/lib/reports/access";
import { getReportById } from "@/lib/reports/repository";
import { getEntityMeta } from "@/lib/reports/schemas";
import type { ReportEntityType } from "@/db/schema/saved-reports";
import { AutoPrint } from "./auto-print";
import "./print.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Report — print",
  robots: { index: false },
};

/**
 * print-friendly report page. Lives outside `(app)` so the
 * sidebar/topbar/glass chrome is absent. Browser-print first: the user
 * picks "Save as PDF" from the system dialog.
 *
 * v1 ships table-only output (with optional summary header for the
 * visualization). Static SVG chart rendering via Recharts SSR was cut
 * see PHASE11-SUBC-REPORT.md for the rationale.
 */
export default async function ReportPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireSession();
  const { id } = await params;
  const report = await getReportById(id);
  if (!report) notFound();

  await assertCanViewReport(report, viewer);
  const result = await executeReport(report, viewer);
  const meta = getEntityMeta(report.entityType as ReportEntityType);

  return (
    <div className="print-root">
      <button
        type="button"
        data-print-hide
        className="print-hide-btn"
      >
        Use your browser&apos;s Save as PDF in the print dialog
      </button>

      <h1>{report.name}</h1>
      <div className="meta">
        {meta.label} report · Visualization: {report.visualization} ·{" "}
        Generated for {viewer.displayName} at{" "}
        <UserTime value={new Date()} />
      </div>
      {report.description ? (
        <p className="description">{report.description}</p>
      ) : null}

      <section>
        <h2>
          Data ({result.rows.length}
          {result.rows.length === 5000 ? "+" : ""} rows)
        </h2>
        {result.rows.length === 0 ? (
          <p>No rows match this report.</p>
        ) : (
          <table>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c}>{humanize(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td key={c}>{formatCell(r[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="footer">
        Printed by {viewer.displayName ?? viewer.email} on{" "}
        <UserTime value={new Date()} /> · Report scoped to viewer.
      </div>

      <AutoPrint />
    </div>
  );
}

function humanize(s: string): string {
  return s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace("T", " ");
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      try {
        return new Date(v).toISOString().slice(0, 19).replace("T", " ");
      } catch {
        return v;
      }
    }
    return v;
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toString() : v.toFixed(2);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
