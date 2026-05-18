import "server-only";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { logger } from "@/lib/logger";

/**
 * Activity-feed / notification links deep-link entity DETAIL pages
 * (`/contacts/{id}`, `/leads/{id}`, …). When the target entity is gone
 * — or the viewer isn't allowed to see it — the detail route serves a
 * full-page 404 and the notification row dead-ends. This resolves
 * reachability in a batch (one indexed lookup per referenced table)
 * and NULLs the `link` of any row whose target is unreachable; the UI
 * already renders a null link as plain (non-clickable) text and the
 * snapshot `title` still records what happened, so history stays
 * intact — it just stops offering a dead link.
 *
 * The reachability rule replicates each detail route's two `notFound()`
 * triggers (verified against the live routes). NULL `ownerId`
 * (owner-user deleted → `set null`) converges, not diverges: the
 * route's JS `ownerId !== viewer` 404s it and the helper's SQL
 * `owner_id = viewer` excludes it — both suppress.
 *  1. Existence / archived:
 *     - contacts / accounts / opportunities — `[id]/page.tsx` filters
 *       `is_deleted = false`, so an ARCHIVED entity 404s.
 *     - leads — `getLeadById` has NO `is_deleted` filter, so an
 *       ARCHIVED lead still renders; only a hard-deleted / never-
 *       existed lead 404s (applying the soft-delete filter here would
 *       wrongly strip working links to archived leads).
 *  2. Owner/permission visibility — every route also `notFound()`s
 *     when `!canViewAll && ownerId !== viewer` (`canViewAll =
 *     isAdmin || canViewAllRecords`). So a cross-user notification
 *     (task_assigned / mention) linking to a record the recipient
 *     can't see is suppressed too. When the viewer has `canViewAll`
 *     the owner predicate is omitted (they see every row).
 *
 * Both triggers are pushed into the per-segment existence query, so a
 * row is reachable iff its id is in the returned set.
 *
 * Best-effort: a reachability-query failure logs and returns the rows
 * unchanged (degrades to the prior behavior — a possible 404 on click
 * — never a broken notifications surface).
 *
 * Only `/{leads|contacts|accounts|opportunities}/{uuid}` links are
 * checked; list/admin/anchor links (`/tasks`, `/admin/users`, …) never
 * 404 and are left untouched.
 */
const DETAIL_LINK_RE =
  /^\/(leads|contacts|accounts|opportunities)\/([0-9a-fA-F-]{36})$/;

const SEGMENTS = {
  // archivedStill404: does the detail route 404 a soft-deleted row?
  leads: { table: leads, archivedStill404: false },
  contacts: { table: contacts, archivedStill404: true },
  accounts: { table: crmAccounts, archivedStill404: true },
  opportunities: { table: opportunities, archivedStill404: true },
} as const;

type DetailSegment = keyof typeof SEGMENTS;

export interface LinkReachabilityViewer {
  /** The user the notifications belong to (the rows' recipient). */
  id: string;
  /** isAdmin || canViewAllRecords — when true the owner gate is skipped. */
  canViewAll: boolean;
}

export async function nullifyUnreachableEntityLinks<
  T extends { link: string | null },
>(rows: T[], viewer: LinkReachabilityViewer): Promise<T[]> {
  const idsBySegment = new Map<DetailSegment, Set<string>>();
  for (const row of rows) {
    if (!row.link) continue;
    const m = DETAIL_LINK_RE.exec(row.link);
    if (!m) continue;
    const seg = m[1] as DetailSegment;
    const id = m[2];
    let set = idsBySegment.get(seg);
    if (!set) {
      set = new Set();
      idsBySegment.set(seg, set);
    }
    set.add(id);
  }
  if (idsBySegment.size === 0) return rows;

  try {
    const reachable = new Map<DetailSegment, Set<string>>();
    await Promise.all(
      [...idsBySegment.entries()].map(async ([seg, ids]) => {
        const { table, archivedStill404 } = SEGMENTS[seg];
        const conds: SQL[] = [inArray(table.id, [...ids])];
        // Trigger 1: archived 404s for everything except leads.
        if (archivedStill404) conds.push(eq(table.isDeleted, false));
        // Trigger 2: owner/permission gate — replicates the route's
        // `!canViewAll && ownerId !== viewer` notFound().
        // NULL owner_id (owner-user deleted → set null) is excluded
        // here (SQL `= viewer` is unknown), and the route's JS
        // `ownerId !== viewer` likewise 404s it — convergent.
        if (!viewer.canViewAll) conds.push(eq(table.ownerId, viewer.id));
        const where = conds.length === 1 ? conds[0] : and(...conds);
        const found = await db
          .select({ id: table.id })
          .from(table)
          .where(where);
        reachable.set(seg, new Set(found.map((f) => f.id)));
      }),
    );

    return rows.map((row) => {
      if (!row.link) return row;
      const m = DETAIL_LINK_RE.exec(row.link);
      if (!m) return row;
      const ok = reachable.get(m[1] as DetailSegment)?.has(m[2]) ?? false;
      return ok ? row : { ...row, link: null };
    });
  } catch (err) {
    logger.warn("notifications.link_reachability_failed", {
      rowCount: rows.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return rows;
  }
}
