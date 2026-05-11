import { type NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 13 — CSV export of `/admin/audit` filtered set.
 *
 * Mirrors the same WHERE clauses as the page (free-text + action +
 * entity type + date range) so what the admin sees is what they
 * download. Capped at 50,000 rows to bound memory; the page UI tells
 * the user about the cap. The export itself writes an audit row so
 * data egress is traceable.
 */
const MAX_ROWS = 50_000;

export async function GET(req: NextRequest) {
  const user = await requireAdmin();
  const sp = req.nextUrl.searchParams;

  const wheres = buildWhereClauses({
    q: sp.get("q") ?? undefined,
    action: sp.get("action") ?? undefined,
    targetType: sp.get("target_type") ?? undefined,
    requestId: sp.get("request_id") ?? undefined,
    createdAtGte: sp.get("created_at_gte") ?? undefined,
    createdAtLte: sp.get("created_at_lte") ?? undefined,
  });
  const where = wheres.length > 0 ? and(...wheres) : undefined;

  // Generous timeout — exporting 50k rows from a multi-million-row
  // table can be slow if filters are loose. 30s caps runaway queries.
  await db.execute(sql`SET LOCAL statement_timeout = '30s'`);

  const rows = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorDisplayName: users.displayName,
      actorEmail: auditLog.actorEmailSnapshot,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      requestId: auditLog.requestId,
      ipAddress: auditLog.ipAddress,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(MAX_ROWS);

  const headers = [
    "When (UTC)",
    "Actor",
    "Actor email",
    "Action",
    "Target type",
    "Target ID",
    "Request ID",
    "IP",
    "Before",
    "After",
  ];
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
        r.actorDisplayName ?? "",
        r.actorEmail ?? "",
        r.action,
        r.targetType ?? "",
        r.targetId ?? "",
        r.requestId ?? "",
        r.ipAddress ?? "",
        r.beforeJson ? JSON.stringify(r.beforeJson) : "",
        r.afterJson ? JSON.stringify(r.afterJson) : "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const csv = `﻿${lines.join("\r\n")}\r\n`;

  await writeAudit({
    actorId: user.id,
    action: "audit_log.export",
    targetType: "audit_log",
    after: {
      row_count: rows.length,
      capped: rows.length === MAX_ROWS,
      filters: {
        q: sp.get("q") ?? null,
        action: sp.get("action") ?? null,
        target_type: sp.get("target_type") ?? null,
        request_id: sp.get("request_id") ?? null,
        created_at_gte: sp.get("created_at_gte") ?? null,
        created_at_lte: sp.get("created_at_lte") ?? null,
      },
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mwg-crm-audit-${stamp}.csv"`,
    },
  });
}

interface AuditFilterInput {
  q?: string;
  action?: string;
  targetType?: string;
  requestId?: string;
  createdAtGte?: string;
  createdAtLte?: string;
}

function buildWhereClauses(f: AuditFilterInput) {
  const wheres = [] as ReturnType<typeof and>[];
  if (f.q && f.q.trim()) {
    const pattern = `%${f.q.trim()}%`;
    wheres.push(
      or(
        ilike(auditLog.action, pattern),
        ilike(auditLog.targetType, pattern),
        ilike(auditLog.targetId, pattern),
        ilike(users.displayName, pattern),
        ilike(users.email, pattern),
      ),
    );
  }
  if (f.action) wheres.push(eq(auditLog.action, f.action));
  if (f.targetType) wheres.push(eq(auditLog.targetType, f.targetType));
  // Phase 25 §4.3 P2 follow-up — exact-match on requestId (no
  // wildcard scan).
  if (f.requestId && f.requestId.trim())
    wheres.push(eq(auditLog.requestId, f.requestId.trim()));
  if (f.createdAtGte) {
    const d = new Date(f.createdAtGte);
    if (!Number.isNaN(d.getTime())) {
      wheres.push(gte(auditLog.createdAt, d));
    }
  }
  if (f.createdAtLte) {
    // Inclusive end-of-day if a bare date is supplied.
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(f.createdAtLte);
    const d = isDateOnly
      ? new Date(`${f.createdAtLte}T23:59:59.999Z`)
      : new Date(f.createdAtLte);
    if (!Number.isNaN(d.getTime())) {
      wheres.push(lte(auditLog.createdAt, d));
    }
  }
  return wheres.filter(Boolean);
}

function csvEscape(value: string): string {
  if (value === "" || value === null || value === undefined) return "";
  const needsQuotes = /[",\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}
