import "server-only";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Visibility-aware query helpers for marketing
 * templates.
 *
 * The rule (locked in the brief): a user can SEE a template iff
 *
 * scope = 'global'
 * OR
 * (scope = 'personal' AND created_by_id = $userId)
 *
 * Admins see everything in this CRM, but admin-bypass is folded into
 * the caller (e.g. server actions that resolve `requireSession()` and
 * check `user.isAdmin`); these helpers are deliberately scoped to the
 * common case so list pages, the campaign template-picker, and the
 * public REST endpoint share one truth-source.
 *
 * Edit/clone gates live in the action layer in
 * `src/app/(app)/marketing/templates/actions.ts` — they additionally
 * consider `canMarketingTemplatesEdit`.
 *
 * NOTE on `created_by_id`: the existing schema uses snake_case in SQL
 * (`created_by_id`) and camelCase in TS (`createdById`). The brief's
 * `creatorUserId` is purely the design-doc name; the column is and
 * remains `created_by_id` / `marketingTemplates.createdById`.
 */

/**
 * Drizzle `WHERE` fragment that filters `marketing_templates` rows to
 * those visible to `userId`. Compose with other `where` predicates via
 * `and(...)` — see `listTemplatesForUser` below for the canonical
 * pattern.
 *
 * Caller composes the soft-delete (`isDeleted = false`) gate
 * separately — some queries want archived templates and shouldn't
 * have the gate hard-coded here.
 */
export function templateVisibilityWhere(userId: string): SQL {
  // SAFETY: `or()` may return undefined when given no truthy
  // operands; that can't happen here because both inputs are SQL
  // builder calls. The `as SQL` cast keeps the public type tight.
  return or(
    eq(marketingTemplates.scope, "global"),
    and(
      eq(marketingTemplates.scope, "personal"),
      eq(marketingTemplates.createdById, userId),
    ),
  ) as SQL;
}

/**
 * True when `userId` is allowed to edit `template`. Mirrors the gate
 * inside `updateTemplateAction`:
 *
 * personal → only the creator may edit.
 * global → creator OR `canMarketingTemplatesEdit` may edit.
 *
 * Pass `isAdmin = true` to bypass (admin gates are usually applied
 * upstream, but inline call sites can short-circuit through this
 * arg).
 */
export function canEditTemplate(input: {
  template: { scope: "global" | "personal"; createdById: string };
  userId: string;
  canMarketingTemplatesEdit: boolean;
  isAdmin?: boolean;
}): boolean {
  if (input.isAdmin) return true;
  if (input.template.createdById === input.userId) return true;
  if (input.template.scope === "personal") return false;
  return input.canMarketingTemplatesEdit;
}

/**
 * True when `userId` can see `template`. Mirrors
 * `templateVisibilityWhere` for the single-row check (used by
 * `/marketing/templates/[id]` and `/marketing/templates/[id]/edit`
 * before rendering).
 */
export function canViewTemplate(input: {
  template: { scope: "global" | "personal"; createdById: string };
  userId: string;
  isAdmin?: boolean;
}): boolean {
  if (input.isAdmin) return true;
  if (input.template.scope === "global") return true;
  return input.template.createdById === input.userId;
}

/**
 * Row shape returned by `listTemplatesCursor`. Mirrors the columns the
 * templates list page renders today (name + subject + status pill +
 * visibility pill + creator + updated timestamp).
 */
export interface MarketingTemplateRow {
  id: string;
  name: string;
  subject: string;
  status: "draft" | "ready" | "archived";
  scope: "global" | "personal";
  updatedAt: Date;
  createdAt: Date;
  createdById: string;
  createdByName: string | null;
}

export interface MarketingTemplateCursorFilters {
  search?: string;
  status?: "draft" | "ready" | "archived" | "all";
  scope?: "global" | "personal" | "all";
}

/**
 * Cursor-paginated visibility-aware list of marketing templates.
 *
 * Default sort: `(updated_at DESC NULLS LAST, id DESC)`. The cursor is
 * the canonical opaque `(ts, id)` tuple from `@/lib/cursors`; the
 * tuple comparison expands manually because `updated_at` is `NOT NULL`
 * (no NULL-block branch needed today, but the codec stays consistent
 * with leads so the cursor decoder is shared).
 *
 * Visibility: composed via `templateVisibilityWhere(user.id)` unless
 * `isAdmin === true`, in which case admin sees every template.
 */
export async function listTemplatesCursor(args: {
  userId: string;
  isAdmin: boolean;
  filters: MarketingTemplateCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: MarketingTemplateRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { userId, isAdmin, filters } = args;

  const wheres: SQL[] = [eq(marketingTemplates.isDeleted, false)];

  if (!isAdmin) {
    wheres.push(templateVisibilityWhere(userId));
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    const searchClause = or(
      ilike(marketingTemplates.name, pattern),
      ilike(marketingTemplates.subject, pattern),
    );
    if (searchClause) wheres.push(searchClause);
  }
  if (filters.status && filters.status !== "all") {
    wheres.push(eq(marketingTemplates.status, filters.status));
  }
  if (filters.scope && filters.scope !== "all") {
    wheres.push(eq(marketingTemplates.scope, filters.scope));
  }

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    // updated_at is NOT NULL, so the simple (ts, id) lexicographic
    // expansion is sufficient.
    if (parsedCursor.ts === null) {
      // Defensive — shouldn't happen for NOT NULL columns. Treat as
      // "no cursor" rather than throwing so a malformed bookmark
      // gracefully degrades to the first page.
      return undefined;
    }
    return sql`(
      ${marketingTemplates.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${marketingTemplates.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${marketingTemplates.id} < ${parsedCursor.id})
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: marketingTemplates.id,
        name: marketingTemplates.name,
        subject: marketingTemplates.subject,
        status: marketingTemplates.status,
        scope: marketingTemplates.scope,
        updatedAt: marketingTemplates.updatedAt,
        createdAt: marketingTemplates.createdAt,
        createdById: marketingTemplates.createdById,
        createdByName: users.displayName,
      })
      .from(marketingTemplates)
      .leftJoin(users, eq(users.id, marketingTemplates.createdById))
      .where(finalWhere)
      .orderBy(desc(marketingTemplates.updatedAt), desc(marketingTemplates.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketingTemplates)
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
