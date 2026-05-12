import "server-only";

import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import {
  marketingListMembers,
  marketingLists,
  marketingStaticListMembers,
} from "@/db/schema/marketing-lists";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { ValidationError } from "@/lib/errors";

/**
 * Unified list-resolution at send time.
 *
 * The marketing send pipeline used to read directly from
 * `marketing_list_members` (the lead-snapshot table). With static lists,
 * recipients can live in either:
 * • `marketing_list_members` (dynamic lists, joined to `leads`)
 * • `marketing_static_list_members` (imported recipients, free email/name)
 *
 * `resolveListRecipients(listId)` branches on `marketing_lists.list_type`
 * and returns a unified shape the send path can consume without knowing
 * which source it came from. Suppressions are filtered out at the SQL
 * layer in BOTH branches so suppressed emails never reach the campaign
 * recipient table.
 *
 * For dynamic lists today: only `source_entity = 'leads'` is
 * wired. Other source entities are reserved for future phases; the
 * resolver errors clearly if they're requested.
 */

export interface ResolvedRecipient {
  /**
   * Canonical lead id when the source is a dynamic lead list. NULL for
   * static-imported recipients (no lead row backs them).
   */
  leadId: string | null;
  email: string;
  /**
   * First name. Static recipients store full name in `name`; the
   * resolver splits on the first whitespace so merge data still has
   * `firstName` populated (best-effort).
   */
  firstName: string;
  lastName: string | null;
  /**
   * The remaining CRM fields below come from the leads join for
   * dynamic lists. Static-imported rows leave them blank — the
   * `buildMergeData` helper in send.ts handles the empty case.
   */
  companyName: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
}

export interface ResolveListRecipientsResult {
  /** The list row, for upstream audit / context. */
  listId: string;
  listType: "dynamic" | "static_imported";
  recipients: ResolvedRecipient[];
}

export async function resolveListRecipients(
  listId: string,
): Promise<ResolveListRecipientsResult> {
  const [list] = await db
    .select({
      id: marketingLists.id,
      listType: marketingLists.listType,
      sourceEntity: marketingLists.sourceEntity,
      isDeleted: marketingLists.isDeleted,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, listId))
    .limit(1);
  if (!list) throw new ValidationError("List not found.");
  if (list.isDeleted) throw new ValidationError("List is archived.");

  // Build the suppressed-email subquery once — used by both branches.
  const suppressedSubq = db
    .select({ email: marketingSuppressions.email })
    .from(marketingSuppressions);

  if (list.listType === "dynamic") {
    if (list.sourceEntity !== "leads") {
      throw new ValidationError(
        `source_entity '${list.sourceEntity ?? "null"}' is not yet supported for sending.`,
      );
    }
    const rows = await db
      .select({
        leadId: leads.id,
        email: marketingListMembers.email,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        jobTitle: leads.jobTitle,
        city: leads.city,
        state: leads.state,
      })
      .from(marketingListMembers)
      .innerJoin(leads, eq(leads.id, marketingListMembers.leadId))
      .where(
        and(
          eq(marketingListMembers.listId, listId),
          eq(leads.isDeleted, false),
          eq(leads.doNotEmail, false),
          notInArray(marketingListMembers.email, suppressedSubq),
        ),
      );

    return {
      listId,
      listType: "dynamic",
      recipients: rows.map((r) => ({
        leadId: r.leadId,
        email: r.email,
        firstName: r.firstName,
        lastName: r.lastName,
        companyName: r.companyName,
        jobTitle: r.jobTitle,
        city: r.city,
        state: r.state,
      })),
    };
  }

  // static_imported
  const rows = await db
    .select({
      id: marketingStaticListMembers.id,
      email: marketingStaticListMembers.email,
      name: marketingStaticListMembers.name,
    })
    .from(marketingStaticListMembers)
    .where(
      and(
        eq(marketingStaticListMembers.listId, listId),
        notInArray(marketingStaticListMembers.email, suppressedSubq),
      ),
    );

  return {
    listId,
    listType: "static_imported",
    recipients: rows.map((r) => {
      const trimmed = r.name?.trim() ?? "";
      const [firstName, ...rest] = trimmed.length > 0 ? trimmed.split(/\s+/) : [""];
      const lastName = rest.length > 0 ? rest.join(" ") : null;
      return {
        leadId: null,
        email: r.email,
        firstName: firstName ?? "",
        lastName,
        companyName: null,
        jobTitle: null,
        city: null,
        state: null,
      };
    }),
  };
}
