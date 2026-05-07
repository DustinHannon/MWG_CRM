import "server-only";
import { logger } from "@/lib/logger";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { recentViews } from "@/db/schema/recent-views";

export type EntityType = "lead" | "contact" | "account" | "opportunity";

/**
 * Phase 3I — fire-and-forget upsert from any detail page. Failure is
 * silent (it's just an MRU cache, never load-bearing).
 */
export async function trackView(
  userId: string,
  entityType: EntityType,
  entityId: string,
): Promise<void> {
  try {
    await db
      .insert(recentViews)
      .values({ userId, entityType, entityId })
      .onConflictDoUpdate({
        target: [
          recentViews.userId,
          recentViews.entityType,
          recentViews.entityId,
        ],
        set: { viewedAt: sql`now()` },
      });

    // Trim to 50 entries.
    await db.execute(sql`
      DELETE FROM recent_views
      WHERE user_id = ${userId}
        AND (entity_type, entity_id) NOT IN (
          SELECT entity_type, entity_id
          FROM recent_views
          WHERE user_id = ${userId}
          ORDER BY viewed_at DESC
          LIMIT 50
        )
    `);
  } catch (err) {
    logger.error("recent_views.track_failed", {
      userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

interface RecentViewRow {
  entityType: string;
  entityId: string;
  label: string;
  sublabel: string | null;
  link: string;
}

export async function listRecentForUser(
  userId: string,
  limit = 5,
): Promise<RecentViewRow[]> {
  type Row = {
    entity_type: string;
    entity_id: string;
    label: string;
    sublabel: string | null;
  };
  const rows = (await db.execute<Row>(sql`
    WITH r AS (
      SELECT entity_type, entity_id, viewed_at
      FROM recent_views
      WHERE user_id = ${userId}
      ORDER BY viewed_at DESC
      LIMIT ${limit}
    )
    SELECT
      r.entity_type,
      r.entity_id::text AS entity_id,
      CASE r.entity_type
        WHEN 'lead' THEN concat_ws(' ', l.first_name, l.last_name)
        WHEN 'contact' THEN concat_ws(' ', c.first_name, c.last_name)
        WHEN 'account' THEN a.name
        WHEN 'opportunity' THEN o.name
      END AS label,
      CASE r.entity_type
        WHEN 'lead' THEN l.company_name
        WHEN 'contact' THEN c.email
        WHEN 'account' THEN a.industry
        WHEN 'opportunity' THEN o.stage::text
      END AS sublabel
    FROM r
    LEFT JOIN leads l ON r.entity_type = 'lead' AND l.id = r.entity_id
    LEFT JOIN contacts c ON r.entity_type = 'contact' AND c.id = r.entity_id
    LEFT JOIN crm_accounts a ON r.entity_type = 'account' AND a.id = r.entity_id
    LEFT JOIN opportunities o ON r.entity_type = 'opportunity' AND o.id = r.entity_id
    ORDER BY r.viewed_at DESC
  `)) as unknown as Row[];

  return rows
    .filter((r) => r.label) // skip dangling refs (deleted rows)
    .map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      label: r.label,
      sublabel: r.sublabel,
      link: linkFor(r.entity_type, r.entity_id),
    }));
}

function linkFor(entityType: string, id: string): string {
  switch (entityType) {
    case "lead":
      return `/leads/${id}`;
    case "contact":
      return `/contacts/${id}`;
    case "account":
      return `/accounts/${id}`;
    case "opportunity":
      return `/opportunities/${id}`;
    default:
      return "/";
  }
}
