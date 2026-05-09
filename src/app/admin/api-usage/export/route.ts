import { type NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiUsageLog } from "@/db/schema/api-keys";
import { requireAdmin } from "@/lib/auth-helpers";
import { writeAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 13 — CSV export of `/admin/api-usage` filtered set.
 *
 * Mirrors the page WHERE clauses so what's seen is what gets
 * downloaded. Capped at 50,000 rows. Writes its own audit_log.export
 * entry so data egress remains traceable.
 */
const MAX_ROWS = 50_000;
const STATUS_BUCKETS = [
  { value: "2xx", min: 200, max: 299 },
  { value: "3xx", min: 300, max: 399 },
  { value: "4xx", min: 400, max: 499 },
  { value: "5xx", min: 500, max: 599 },
] as const;

export async function GET(req: NextRequest) {
  const user = await requireAdmin();
  const sp = req.nextUrl.searchParams;

  const wheres: ReturnType<typeof and>[] = [];

  const q = sp.get("q");
  if (q && q.trim()) {
    const pattern = `%${q.trim()}%`;
    wheres.push(
      or(
        ilike(apiUsageLog.action, pattern),
        ilike(apiUsageLog.errorMessage, pattern),
        ilike(apiUsageLog.apiKeyNameSnapshot, pattern),
      ),
    );
  }

  const method = sp.get("method");
  if (method) wheres.push(eq(apiUsageLog.method, method));

  const path = sp.get("path");
  if (path && path.trim()) {
    wheres.push(ilike(apiUsageLog.path, `%${path.trim()}%`));
  }

  const statusBuckets = parseList(sp.get("status"))
    .map((bucket) => STATUS_BUCKETS.find((b) => b.value === bucket))
    .filter((b): b is (typeof STATUS_BUCKETS)[number] => Boolean(b));
  if (statusBuckets.length > 0) {
    const ors = statusBuckets.map(
      (b) =>
        sql`(${apiUsageLog.statusCode} >= ${b.min} AND ${apiUsageLog.statusCode} <= ${b.max})`,
    );
    wheres.push(or(...ors));
  }

  const apiKeyIds = parseList(sp.get("api_key_id"));
  if (apiKeyIds.length > 0) {
    wheres.push(inArray(apiUsageLog.apiKeyId, apiKeyIds));
  }

  const createdGte = sp.get("created_at_gte");
  if (createdGte) {
    const d = new Date(createdGte);
    if (!Number.isNaN(d.getTime())) wheres.push(gte(apiUsageLog.createdAt, d));
  }
  const createdLte = sp.get("created_at_lte");
  if (createdLte) {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(createdLte);
    const d = isDateOnly
      ? new Date(`${createdLte}T23:59:59.999Z`)
      : new Date(createdLte);
    if (!Number.isNaN(d.getTime())) wheres.push(lte(apiUsageLog.createdAt, d));
  }

  const where = wheres.length > 0 ? and(...wheres) : undefined;

  await db.execute(sql`SET LOCAL statement_timeout = '30s'`);

  const rows = await db
    .select({
      id: apiUsageLog.id,
      createdAt: apiUsageLog.createdAt,
      apiKeyNameSnapshot: apiUsageLog.apiKeyNameSnapshot,
      apiKeyPrefixSnapshot: apiUsageLog.apiKeyPrefixSnapshot,
      method: apiUsageLog.method,
      path: apiUsageLog.path,
      action: apiUsageLog.action,
      statusCode: apiUsageLog.statusCode,
      responseTimeMs: apiUsageLog.responseTimeMs,
      ipAddress: apiUsageLog.ipAddress,
      userAgent: apiUsageLog.userAgent,
      errorCode: apiUsageLog.errorCode,
      errorMessage: apiUsageLog.errorMessage,
      requestQuery: apiUsageLog.requestQuery,
      requestBodySummary: apiUsageLog.requestBodySummary,
      responseSummary: apiUsageLog.responseSummary,
    })
    .from(apiUsageLog)
    .where(where)
    .orderBy(desc(apiUsageLog.createdAt), desc(apiUsageLog.id))
    .limit(MAX_ROWS);

  const headers = [
    "When (UTC)",
    "Key name",
    "Key prefix",
    "Method",
    "Path",
    "Action",
    "Status",
    "Latency (ms)",
    "IP",
    "User agent",
    "Error code",
    "Error message",
    "Request query",
    "Request body summary",
    "Response summary",
  ];
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
        r.apiKeyNameSnapshot,
        r.apiKeyPrefixSnapshot,
        r.method,
        r.path,
        r.action ?? "",
        String(r.statusCode),
        r.responseTimeMs == null ? "" : String(r.responseTimeMs),
        r.ipAddress ?? "",
        r.userAgent ?? "",
        r.errorCode ?? "",
        r.errorMessage ?? "",
        r.requestQuery ? JSON.stringify(r.requestQuery) : "",
        r.requestBodySummary ? JSON.stringify(r.requestBodySummary) : "",
        r.responseSummary ? JSON.stringify(r.responseSummary) : "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const csv = `﻿${lines.join("\r\n")}\r\n`;

  await writeAudit({
    actorId: user.id,
    action: "api_usage_log.export",
    targetType: "api_usage_log",
    after: {
      row_count: rows.length,
      capped: rows.length === MAX_ROWS,
      filters: {
        q: sp.get("q") ?? null,
        method: sp.get("method") ?? null,
        path: sp.get("path") ?? null,
        status: sp.get("status") ?? null,
        api_key_id: sp.get("api_key_id") ?? null,
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
      "content-disposition": `attachment; filename="mwg-crm-api-usage-${stamp}.csv"`,
    },
  });
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function csvEscape(value: string): string {
  if (value === "" || value === null || value === undefined) return "";
  const needsQuotes = /[",\r\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}
