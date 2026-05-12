import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { formatPersonNameRow } from "@/lib/format/person-name";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SearchHit {
  type: "lead" | "contact" | "account" | "opportunity" | "task" | "tag";
  id: string;
  label: string;
  sublabel: string | null;
  link: string;
}

/**
 * Cmd+K cross-entity search backed by Postgres FTS + pg_trgm.
 * Replaces the ILIKE implementation. Each entity gets a UNION of:
 * websearch_to_tsquery against the FTS GIN index (high score).
 * pg_trgm `%` similarity for typo tolerance (lower score).
 * Results are deduped, ordered by score, capped at 10/entity.
 *
 * Owner-scope respected for non-admins without canViewAllRecords. Archived
 * rows are filtered out by the partial GIN indexes.
 */
export async function GET(req: Request) {
  const session = await requireSession();
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length === 0) return NextResponse.json({ hits: [] });

  const perms = await getPermissions(session.id);
  const canViewAll = session.isAdmin || perms.canViewAllRecords;
  const ownerScope = canViewAll ? sql`TRUE` : sql`l.owner_id = ${session.id}`;
  const accountScope = canViewAll ? sql`TRUE` : sql`a.owner_id = ${session.id}`;
  const contactScope = canViewAll ? sql`TRUE` : sql`c.owner_id = ${session.id}`;
  const oppScope = canViewAll ? sql`TRUE` : sql`o.owner_id = ${session.id}`;
  const hits: SearchHit[] = [];

  try {
    // LEADS — FTS + trigram fuzzy. Partial indexes already filter is_deleted=false.
    const leadRows = await db.execute<{
      id: string;
      first_name: string;
      last_name: string;
      company_name: string | null;
      email: string | null;
    }>(sql`
      WITH fts AS (
        SELECT id, first_name, last_name, company_name, email, 1.0::float AS score
        FROM leads l
        WHERE l.is_deleted = false
          AND ${ownerScope}
          AND to_tsvector('english',
            coalesce(first_name,'') || ' ' ||
            coalesce(last_name,'')  || ' ' ||
            coalesce(company_name,'') || ' ' ||
            coalesce(email,'')      || ' ' ||
            coalesce(phone,'')
          ) @@ websearch_to_tsquery('english', ${q})
        LIMIT 20
      ),
      trgm AS (
        SELECT l.id, l.first_name, l.last_name, l.company_name, l.email,
          GREATEST(
            similarity(coalesce(first_name,'') || ' ' || coalesce(last_name,''), ${q}),
            similarity(coalesce(company_name,''), ${q})
          )::float AS score
        FROM leads l
        WHERE l.is_deleted = false
          AND ${ownerScope}
          AND (
            (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) % ${q}
            OR coalesce(company_name,'') % ${q}
          )
        LIMIT 20
      )
      SELECT id, first_name, last_name, company_name, email FROM (
        SELECT *, max(score) OVER (PARTITION BY id) AS s FROM (
          SELECT * FROM fts UNION ALL SELECT * FROM trgm
        ) u
      ) v
      GROUP BY id, first_name, last_name, company_name, email, s
      ORDER BY s DESC
      LIMIT 10
    `);
    for (const r of leadRows) {
      hits.push({
        type: "lead",
        id: r.id,
        label: formatPersonNameRow(r),
        sublabel: r.company_name ?? r.email ?? null,
        link: `/leads/${r.id}`,
      });
    }

    // ACCOUNTS
    const accountRows = await db.execute<{
      id: string;
      name: string;
      industry: string | null;
    }>(sql`
      SELECT id, name, industry FROM (
        SELECT a.id, a.name, a.industry, 1.0::float AS s
        FROM crm_accounts a
        WHERE a.is_deleted = false AND ${accountScope}
          AND to_tsvector('english', coalesce(a.name,'') || ' ' || coalesce(a.website,'')) @@ websearch_to_tsquery('english', ${q})
        UNION ALL
        SELECT a.id, a.name, a.industry, similarity(a.name, ${q})::float
        FROM crm_accounts a
        WHERE a.is_deleted = false AND ${accountScope} AND a.name % ${q}
      ) u
      GROUP BY id, name, industry
      ORDER BY max(s) DESC
      LIMIT 10
    `);
    for (const r of accountRows) {
      hits.push({
        type: "account",
        id: r.id,
        label: r.name,
        sublabel: r.industry,
        link: `/accounts/${r.id}`,
      });
    }

    // CONTACTS
    const contactRows = await db.execute<{
      id: string;
      first_name: string;
      last_name: string;
      email: string | null;
    }>(sql`
      SELECT id, first_name, last_name, email FROM (
        SELECT c.id, c.first_name, c.last_name, c.email, 1.0::float AS s
        FROM contacts c
        WHERE c.is_deleted = false AND ${contactScope}
          AND to_tsvector('english',
            coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'') || ' ' || coalesce(c.email,''))
            @@ websearch_to_tsquery('english', ${q})
        UNION ALL
        SELECT c.id, c.first_name, c.last_name, c.email,
          similarity(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''), ${q})::float
        FROM contacts c
        WHERE c.is_deleted = false AND ${contactScope}
          AND (coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) % ${q}
      ) u
      GROUP BY id, first_name, last_name, email
      ORDER BY max(s) DESC
      LIMIT 10
    `);
    for (const r of contactRows) {
      hits.push({
        type: "contact",
        id: r.id,
        label: formatPersonNameRow(r),
        sublabel: r.email ?? null,
        link: `/contacts/${r.id}`,
      });
    }

    // OPPORTUNITIES
    const oppRows = await db.execute<{
      id: string;
      name: string;
      stage: string;
    }>(sql`
      SELECT id, name, stage FROM opportunities o
      WHERE o.is_deleted = false AND ${oppScope}
        AND (
          to_tsvector('english', coalesce(o.name,'')) @@ websearch_to_tsquery('english', ${q})
          OR o.name % ${q}
        )
      ORDER BY similarity(o.name, ${q}) DESC
      LIMIT 10
    `);
    for (const r of oppRows) {
      hits.push({
        type: "opportunity",
        id: r.id,
        label: r.name,
        sublabel: r.stage,
        link: `/opportunities/${r.id}`,
      });
    }

    // TASKS — only those assigned to me. Plain ILIKE since we lack a TS index here.
    const taskRows = await db.execute<{
      id: string;
      title: string;
      status: string;
    }>(sql`
      SELECT id, title, status::text AS status FROM tasks
      WHERE is_deleted = false
        AND assigned_to_id = ${session.id}
        AND title ILIKE ${'%' + q + '%'}
      LIMIT 10
    `);
    for (const r of taskRows) {
      hits.push({
        type: "task",
        id: r.id,
        label: r.title,
        sublabel: r.status,
        link: "/tasks",
      });
    }

    // TAGS
    const tagRows = await db.execute<{
      id: string;
      name: string;
      color: string;
    }>(sql`
      SELECT id, name, color FROM tags
      WHERE name ILIKE ${'%' + q + '%'} OR name % ${q}
      ORDER BY similarity(name, ${q}) DESC
      LIMIT 5
    `);
    for (const r of tagRows) {
      hits.push({
        type: "tag",
        id: r.id,
        label: r.name,
        sublabel: r.color,
        link: `/leads?tag=${encodeURIComponent(r.name)}`,
      });
    }
  } catch (err) {
    logger.error("search.failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ hits });
}
