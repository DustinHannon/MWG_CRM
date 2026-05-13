import "server-only";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { marketingLists } from "@/db/schema/marketing-lists";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listCampaignsCursor`. Mirrors the columns
 * the marketing campaigns page renders (name + template + list +
 * status + sent counts + opens + updated).
 */
export interface MarketingCampaignRow {
  id: string;
  name: string;
  status:
    | "draft"
    | "scheduled"
    | "sending"
    | "sent"
    | "failed"
    | "cancelled";
  scheduledFor: Date | null;
  sentAt: Date | null;
  totalRecipients: number;
  totalSent: number;
  totalOpened: number;
  templateName: string | null;
  listName: string | null;
  createdByName: string | null;
  updatedAt: Date;
}

export type MarketingCampaignStatus = MarketingCampaignRow["status"];

export interface MarketingCampaignCursorFilters {
  search?: string;
  status?: MarketingCampaignStatus | "all";
  templateId?: string;
  listId?: string;
}

/**
 * Cursor-paginated list of marketing campaigns.
 *
 * Default sort: `(updated_at DESC, id DESC)`. The cursor codec is the
 * canonical `(ts, id)` opaque token from `@/lib/cursors`.
 *
 * Visibility: campaign rows are visible to anyone with the
 * `canMarketingCampaignsView` permission.
 */
export async function listCampaignsCursor(args: {
  filters: MarketingCampaignCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: MarketingCampaignRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { filters } = args;

  const wheres: SQL[] = [eq(marketingCampaigns.isDeleted, false)];

  if (filters.search) {
    const pattern = `%${filters.search}%`;
    const clause = or(
      ilike(marketingCampaigns.name, pattern),
      ilike(marketingCampaigns.fromEmail, pattern),
    );
    if (clause) wheres.push(clause);
  }
  if (filters.status && filters.status !== "all") {
    wheres.push(eq(marketingCampaigns.status, filters.status));
  }
  if (filters.templateId) {
    wheres.push(eq(marketingCampaigns.templateId, filters.templateId));
  }
  if (filters.listId) {
    wheres.push(eq(marketingCampaigns.listId, filters.listId));
  }

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) return undefined;
    return sql`(
      ${marketingCampaigns.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${marketingCampaigns.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${marketingCampaigns.id} < ${parsedCursor.id})
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: marketingCampaigns.id,
        name: marketingCampaigns.name,
        status: marketingCampaigns.status,
        scheduledFor: marketingCampaigns.scheduledFor,
        sentAt: marketingCampaigns.sentAt,
        totalRecipients: marketingCampaigns.totalRecipients,
        totalSent: marketingCampaigns.totalSent,
        totalOpened: marketingCampaigns.totalOpened,
        templateName: marketingTemplates.name,
        listName: marketingLists.name,
        createdByName: users.displayName,
        updatedAt: marketingCampaigns.updatedAt,
      })
      .from(marketingCampaigns)
      .leftJoin(
        marketingTemplates,
        eq(marketingTemplates.id, marketingCampaigns.templateId),
      )
      .leftJoin(marketingLists, eq(marketingLists.id, marketingCampaigns.listId))
      .leftJoin(users, eq(users.id, marketingCampaigns.createdById))
      .where(finalWhere)
      .orderBy(
        desc(marketingCampaigns.updatedAt),
        desc(marketingCampaigns.id),
      )
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingCampaigns)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.updatedAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}
