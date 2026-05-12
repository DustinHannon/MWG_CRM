import "server-only";

import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  marketingLists,
  marketingStaticListMembers,
} from "@/db/schema/marketing-lists";
import { likeContains } from "@/lib/security/like-escape";
import { NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Phase 29 §5 — Lib helpers for the `marketing_static_list_members`
 * table (CSV/XLSX-imported recipients living outside the CRM lead graph).
 *
 * Canonical naming per CLAUDE.md §"Naming":
 *   • list (single)             : `getStaticListMemberById`
 *   • list (many)               : `listStaticListMembersForList`
 *   • create                    : `createStaticListMember`
 *   • bulk create               : `createStaticListMembers`
 *   • update                    : `updateStaticListMember`
 *   • bulk update               : `bulkUpdateStaticListMembers`
 *   • hard-delete (caller writes audit per-row): `deleteStaticListMembersById`
 *
 * Server actions live in `src/app/(app)/marketing/lists/actions.ts`. This
 * module assumes the caller has already gated on session + permission.
 */

export type StaticMemberSortKey = "name" | "email" | "added";
export type SortDirection = "asc" | "desc";

export interface ListStaticListMembersForListOptions {
  /** Optional substring match against `name` OR `email`. */
  search?: string | null;
  sortKey?: StaticMemberSortKey;
  sortDir?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface StaticListMemberRow {
  id: string;
  listId: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getStaticListMemberById(
  memberId: string,
): Promise<StaticListMemberRow | null> {
  const [row] = await db
    .select({
      id: marketingStaticListMembers.id,
      listId: marketingStaticListMembers.listId,
      email: marketingStaticListMembers.email,
      name: marketingStaticListMembers.name,
      createdAt: marketingStaticListMembers.createdAt,
      updatedAt: marketingStaticListMembers.updatedAt,
    })
    .from(marketingStaticListMembers)
    .where(eq(marketingStaticListMembers.id, memberId))
    .limit(1);
  return row ?? null;
}

export async function listStaticListMembersForList(
  listId: string,
  opts: ListStaticListMembersForListOptions = {},
): Promise<{
  rows: StaticListMemberRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 50), 500);
  const sortKey = opts.sortKey ?? "added";
  const sortDir = opts.sortDir ?? "desc";

  const search = opts.search?.trim() ?? "";
  const where = and(
    eq(marketingStaticListMembers.listId, listId),
    search
      ? or(
          sql`lower(${marketingStaticListMembers.email}) like lower(${likeContains(search)})`,
          sql`lower(coalesce(${marketingStaticListMembers.name}, '')) like lower(${likeContains(search)})`,
        )
      : undefined,
  );

  const sortColumn = (() => {
    switch (sortKey) {
      case "name":
        return marketingStaticListMembers.name;
      case "email":
        return marketingStaticListMembers.email;
      case "added":
      default:
        return marketingStaticListMembers.createdAt;
    }
  })();
  const orderExpr =
    sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (page - 1) * pageSize;
  const rows = await db
    .select({
      id: marketingStaticListMembers.id,
      listId: marketingStaticListMembers.listId,
      email: marketingStaticListMembers.email,
      name: marketingStaticListMembers.name,
      createdAt: marketingStaticListMembers.createdAt,
      updatedAt: marketingStaticListMembers.updatedAt,
    })
    .from(marketingStaticListMembers)
    .where(where)
    .orderBy(orderExpr)
    .limit(pageSize)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(marketingStaticListMembers)
    .where(where);

  return {
    rows,
    total: total ?? 0,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil((total ?? 0) / pageSize)),
  };
}

export interface StaticMemberInput {
  email: string;
  name?: string | null;
}

/**
 * Insert one or more rows into `marketing_static_list_members`. Returns
 * the inserted row count (after onConflictDoNothing dedup on
 * (list_id, lower(email))).
 *
 * The caller is responsible for refreshing `marketing_lists.member_count`
 * (we do it here automatically since every insert path needs it).
 */
export async function createStaticListMembers(args: {
  listId: string;
  members: StaticMemberInput[];
  actorId: string | null;
}): Promise<{ inserted: number }> {
  if (args.members.length === 0) return { inserted: 0 };

  // Confirm parent list exists / not archived.
  const [list] = await db
    .select({
      id: marketingLists.id,
      isDeleted: marketingLists.isDeleted,
      listType: marketingLists.listType,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, args.listId))
    .limit(1);
  if (!list || list.isDeleted) {
    throw new NotFoundError("marketing list");
  }
  if (list.listType !== "static_imported") {
    throw new ValidationError(
      "Static members can only be added to a static-imported list.",
    );
  }

  let inserted = 0;
  for (let i = 0; i < args.members.length; i += 1000) {
    const slice = args.members.slice(i, i + 1000);
    const rows = await db
      .insert(marketingStaticListMembers)
      .values(
        slice.map((m) => ({
          listId: args.listId,
          email: m.email.trim().toLowerCase(),
          name: m.name?.trim() || null,
          createdById: args.actorId,
          updatedById: args.actorId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: marketingStaticListMembers.id });
    inserted += rows.length;
  }

  if (inserted > 0) {
    await syncStaticListMemberCount(args.listId);
  }

  return { inserted };
}

export interface UpdateStaticMemberPatch {
  email?: string;
  name?: string | null;
}

/**
 * Update one static member. Returns the updated row or null if not
 * found. Throws ValidationError on a (list_id, lower(email)) unique
 * conflict so the caller can surface it.
 */
export async function updateStaticListMember(args: {
  memberId: string;
  patch: UpdateStaticMemberPatch;
  actorId: string | null;
}): Promise<StaticListMemberRow | null> {
  const patch: Record<string, unknown> = {
    updatedAt: sql`now()`,
    updatedById: args.actorId,
  };
  if (args.patch.email !== undefined) {
    patch.email = args.patch.email.trim().toLowerCase();
  }
  if (args.patch.name !== undefined) {
    patch.name = args.patch.name?.trim() ? args.patch.name.trim() : null;
  }
  if (Object.keys(patch).length <= 2) {
    // Only updatedAt + updatedById → no real change requested.
    return getStaticListMemberById(args.memberId);
  }

  try {
    const [row] = await db
      .update(marketingStaticListMembers)
      .set(patch)
      .where(eq(marketingStaticListMembers.id, args.memberId))
      .returning({
        id: marketingStaticListMembers.id,
        listId: marketingStaticListMembers.listId,
        email: marketingStaticListMembers.email,
        name: marketingStaticListMembers.name,
        createdAt: marketingStaticListMembers.createdAt,
        updatedAt: marketingStaticListMembers.updatedAt,
      });
    return row ?? null;
  } catch (err) {
    // 23505 = unique violation on (list_id, lower(email)).
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      throw new ValidationError(
        "Another member in this list already uses that email.",
      );
    }
    throw err;
  }
}

/**
 * Bulk update a field across many rows. Used by the static-list detail
 * page's bulk-edit modal. Only `name` is safe for bulk write (bulk
 * email-rewrite would risk uniqueness conflicts — that path stays
 * per-row).
 */
export async function bulkUpdateStaticListMembers(args: {
  memberIds: string[];
  field: "name";
  value: string | null;
  actorId: string | null;
}): Promise<{ updated: number }> {
  if (args.memberIds.length === 0) return { updated: 0 };
  const trimmed =
    typeof args.value === "string"
      ? args.value.trim() || null
      : args.value;
  const rows = await db
    .update(marketingStaticListMembers)
    .set({
      name: trimmed,
      updatedAt: sql`now()`,
      updatedById: args.actorId,
    })
    .where(inArray(marketingStaticListMembers.id, args.memberIds))
    .returning({ id: marketingStaticListMembers.id });
  return { updated: rows.length };
}

/**
 * Delete a set of static-list members. Caller is responsible for
 * writing per-row audit events; this helper only mutates the table and
 * refreshes the parent list's denormalized count.
 */
export async function deleteStaticListMembersById(args: {
  listId: string;
  memberIds: string[];
}): Promise<{ removed: number }> {
  if (args.memberIds.length === 0) return { removed: 0 };
  const rows = await db
    .delete(marketingStaticListMembers)
    .where(
      and(
        eq(marketingStaticListMembers.listId, args.listId),
        inArray(marketingStaticListMembers.id, args.memberIds),
      ),
    )
    .returning({ id: marketingStaticListMembers.id });

  if (rows.length > 0) {
    await syncStaticListMemberCount(args.listId);
  }
  return { removed: rows.length };
}

/**
 * Refresh the denormalized `marketing_lists.member_count` for a
 * static-imported list. Called after any mutation that affects row
 * count (insert / delete).
 */
export async function syncStaticListMemberCount(
  listId: string,
): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketingStaticListMembers)
    .where(eq(marketingStaticListMembers.listId, listId));
  const count = n ?? 0;
  await db
    .update(marketingLists)
    .set({
      memberCount: count,
      updatedAt: sql`now()`,
    })
    .where(eq(marketingLists.id, listId));
  return count;
}
