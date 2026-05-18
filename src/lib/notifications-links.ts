import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { logger } from "@/lib/logger";

/**
 * Activity-feed / notification links deep-link entity DETAIL pages
 * (`/contacts/{id}`, `/leads/{id}`, …). When the target entity is gone,
 * the detail route serves a full-page 404 and the notification row
 * dead-ends — most visibly the "Archived X" rows. This resolves
 * reachability in a batch (one indexed PK lookup per referenced table)
 * and NULLs the `link` of any row whose target is unreachable; the UI
 * already renders a null link as plain (non-clickable) text, and the
 * snapshot `title` still records what happened, so history stays
 * intact — it just stops offering a dead link.
 *
 * The 404 trigger differs per entity, so the reachability rule is
 * per-segment (verified against the live detail routes):
 *  - contacts / accounts / opportunities — `[id]/page.tsx` filters
 *    `is_deleted = false` then `notFound()`, so an ARCHIVED entity
 *    404s: reachable ⇔ row exists AND is not soft-deleted.
 *  - leads — `getLeadById` has NO `is_deleted` filter, so an ARCHIVED
 *    lead still renders: reachable ⇔ row merely EXISTS (only a
 *    hard-deleted / never-existed lead 404s). Applying the
 *    soft-delete filter here would wrongly strip working links to
 *    archived leads.
 *
 * Residual NOT handled here (documented, out of this fix's scope —
 * the reported bug + intent is the archived/deleted case): every
 * detail route ALSO `notFound()`s when the viewer lacks
 * owner/permission visibility (`!canViewAll && ownerId !== viewer`).
 * Cross-user notification kinds (task_assigned / mention) can link to
 * an entity the recipient cannot see and would still 404. The
 * actor's-own activity feed (userId === actorId) is unaffected by
 * that residual. Threading viewer id + per-route permission logic is
 * a separate, larger change tracked in the decision log.
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

export async function nullifyUnreachableEntityLinks<
  T extends { link: string | null },
>(rows: T[]): Promise<T[]> {
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
        const idList = [...ids];
        const where = archivedStill404
          ? and(inArray(table.id, idList), eq(table.isDeleted, false))
          : inArray(table.id, idList);
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
