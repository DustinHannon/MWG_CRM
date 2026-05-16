import "server-only";

import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { opportunities } from "@/db/schema/crm-records";
import { externalIds, importRecords } from "@/db/schema/d365-imports";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { D365_AUDIT_EVENTS } from "./audit-events";

/**
 * One-shot, idempotent backfill of NULL parent FKs on already-
 * committed D365 opportunities.
 *
 * Why this exists: opportunities imported before the commit-batch
 * opportunity FK-resolution branch landed were inserted with
 * `account_id` / `primary_contact_id` / `source_lead_id` permanently
 * NULL even when the parent rows existed in `external_ids`. The
 * opportunity mapper did not stash the `_*SourceId` virtuals, so a
 * re-import does not self-heal them (the mapper still produced NULL on
 * the second pass). This sweep re-derives the parent D365 GUIDs from
 * the opportunity's retained `import_records.rawPayload` and resolves
 * them via `external_ids` — the standard ETL quarantine-then-reconcile
 * pattern.
 *
 * Idempotent: only sets a column that is currently NULL, and only when
 * resolution succeeds. Re-running after a later parent import resolves
 * the still-NULL FKs without touching already-resolved ones.
 *
 * Opportunities with no D365 provenance (no `external_ids` row + no
 * staged `import_records.rawPayload`) cannot be resolved from a D365
 * GUID and are NOT fabricated — they are counted under
 * `noSourceProvenance` and left untouched. Inventing FKs would corrupt
 * data; surfacing the count is the honest outcome.
 */

const BATCH_LIMIT = 200;

export interface BackfillOpportunityFksResult {
  /** Live (is_deleted=false) opportunities with ≥1 NULL parent FK. */
  scanned: number;
  /** Opportunities that had ≥1 FK resolved and updated by this run. */
  resolved: number;
  /** Individual FK fields still unresolved (parent not yet imported). */
  stillUnresolved: number;
  /**
   * Opportunities with a NULL FK but no D365 provenance to resolve
   * from (no external_ids row + no staged rawPayload). Left untouched.
   */
  noSourceProvenance: number;
}

interface RawLookups {
  accountSourceId: string | null;
  primaryContactSourceId: string | null;
  sourceLeadSourceId: string | null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Re-derive the parent D365 GUIDs from a verbatim opportunity raw
 * payload, mirroring the opportunity mapper's resolution strategy
 * (`_customerid_value` is D365's polymorphic Customer lookup; prefer
 * the unambiguous typed lookups and fall back to it).
 */
function deriveRawLookups(raw: Record<string, unknown>): RawLookups {
  const customerSourceId = str(raw._customerid_value);
  return {
    accountSourceId: str(raw._parentaccountid_value) ?? customerSourceId,
    primaryContactSourceId:
      str(raw._parentcontactid_value) ?? customerSourceId,
    sourceLeadSourceId: str(raw._originatingleadid_value),
  };
}

async function lookupLocalId(
  entityType: "account" | "contact" | "lead",
  sourceId: string,
): Promise<string | null> {
  const rows = await db
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.source, "d365"),
        eq(externalIds.sourceEntityType, entityType),
        eq(externalIds.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows[0]?.localId ?? null;
}

export async function backfillOpportunityFks(
  actorId: string,
): Promise<BackfillOpportunityFksResult> {
  const result: BackfillOpportunityFksResult = {
    scanned: 0,
    resolved: 0,
    stillUnresolved: 0,
    noSourceProvenance: 0,
  };

  // Keyset pagination on (createdAt, id) — NOT offset. The loop UPDATEs
  // rows OUT of the `IS NULL` orphan predicate as it resolves them, so
  // an OFFSET would skip ~`resolved` still-orphan rows that shift into
  // the offset window on the next page. A keyset cursor advances strictly
  // past the last row already seen by position, so: resolved rows simply
  // never re-appear (they left the predicate), and rows that stay NULL
  // (no-provenance / parent-not-yet-imported) are each visited exactly
  // once and passed by the advancing cursor — guaranteeing termination
  // and a single scan of every orphan. `id` is the unique tiebreaker for
  // the non-unique `created_at` (bulk imports share a timestamp).
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const wheres: SQL[] = [
      eq(opportunities.isDeleted, false),
      or(
        isNull(opportunities.accountId),
        isNull(opportunities.primaryContactId),
        isNull(opportunities.sourceLeadId),
      )!,
    ];
    if (cursor) {
      wheres.push(
        or(
          gt(opportunities.createdAt, cursor.createdAt),
          and(
            eq(opportunities.createdAt, cursor.createdAt),
            gt(opportunities.id, cursor.id),
          ),
        )!,
      );
    }

    const orphans = await db
      .select({
        id: opportunities.id,
        createdAt: opportunities.createdAt,
        accountId: opportunities.accountId,
        primaryContactId: opportunities.primaryContactId,
        sourceLeadId: opportunities.sourceLeadId,
      })
      .from(opportunities)
      .where(and(...wheres))
      .orderBy(opportunities.createdAt, opportunities.id)
      .limit(BATCH_LIMIT);

    if (orphans.length === 0) break;
    result.scanned += orphans.length;
    // Advance the cursor to the last row of this page BEFORE processing
    // — the cursor is positional, independent of whether each row is
    // resolved, so it never revisits or skips a row.
    const last = orphans[orphans.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };

    for (const opp of orphans) {
      // Locate the opportunity's own D365 external_ids row to recover
      // its source GUID, then its retained staged raw payload.
      const ext = await db
        .select({ sourceId: externalIds.sourceId })
        .from(externalIds)
        .where(
          and(
            eq(externalIds.source, "d365"),
            eq(externalIds.sourceEntityType, "opportunity"),
            eq(externalIds.localId, opp.id),
          ),
        )
        .limit(1);
      const oppSourceId = ext[0]?.sourceId ?? null;
      if (!oppSourceId) {
        // No D365 provenance — not a D365-imported opportunity (e.g.
        // lead-converted / seed data). Cannot resolve a GUID; do not
        // fabricate FKs.
        result.noSourceProvenance += 1;
        continue;
      }

      const recRows = await db
        .select({ rawPayload: importRecords.rawPayload })
        .from(importRecords)
        .where(
          and(
            eq(importRecords.sourceEntityType, "opportunity"),
            eq(importRecords.sourceId, oppSourceId),
          ),
        )
        .orderBy(sql`${importRecords.committedAt} DESC NULLS LAST`)
        .limit(1);
      const raw = recRows[0]?.rawPayload;
      if (!raw || typeof raw !== "object") {
        result.noSourceProvenance += 1;
        continue;
      }

      const lookups = deriveRawLookups(raw as Record<string, unknown>);
      const update: Record<string, unknown> = {};

      if (opp.accountId == null && lookups.accountSourceId) {
        const localId = await lookupLocalId(
          "account",
          lookups.accountSourceId,
        );
        if (localId) update.accountId = localId;
        else {
          result.stillUnresolved += 1;
          await writeAudit({
            actorId,
            action: D365_AUDIT_EVENTS.RECORD_FK_UNRESOLVED,
            targetType: "opportunity",
            targetId: opp.id,
            after: {
              field: "accountId",
              foreignEntity: "account",
              foreignSourceId: lookups.accountSourceId,
              viaBackfill: true,
              remediation:
                "re-run the backfill after the parent account is imported",
            },
          });
        }
      }

      if (opp.primaryContactId == null && lookups.primaryContactSourceId) {
        const localId = await lookupLocalId(
          "contact",
          lookups.primaryContactSourceId,
        );
        if (localId) update.primaryContactId = localId;
        else {
          result.stillUnresolved += 1;
          await writeAudit({
            actorId,
            action: D365_AUDIT_EVENTS.RECORD_FK_UNRESOLVED,
            targetType: "opportunity",
            targetId: opp.id,
            after: {
              field: "primaryContactId",
              foreignEntity: "contact",
              foreignSourceId: lookups.primaryContactSourceId,
              viaBackfill: true,
              remediation:
                "re-run the backfill after the parent contact is imported",
            },
          });
        }
      }

      if (opp.sourceLeadId == null && lookups.sourceLeadSourceId) {
        const localId = await lookupLocalId(
          "lead",
          lookups.sourceLeadSourceId,
        );
        if (localId) update.sourceLeadId = localId;
        else {
          result.stillUnresolved += 1;
          await writeAudit({
            actorId,
            action: D365_AUDIT_EVENTS.RECORD_FK_UNRESOLVED,
            targetType: "opportunity",
            targetId: opp.id,
            after: {
              field: "sourceLeadId",
              foreignEntity: "lead",
              foreignSourceId: lookups.sourceLeadSourceId,
              viaBackfill: true,
              remediation:
                "re-run the backfill after the originating lead is imported",
            },
          });
        }
      }

      if (Object.keys(update).length > 0) {
        await db
          .update(opportunities)
          .set(update)
          .where(eq(opportunities.id, opp.id));
        result.resolved += 1;
      }
    }

    // A short page means the keyset window past this cursor is
    // exhausted — no more orphans. (A full page loops back; the next
    // query starts strictly after this page's last row.)
    if (orphans.length < BATCH_LIMIT) break;
  }

  logger.info("d365.backfill.opportunity_fk.summary", {
    actorId,
    scanned: result.scanned,
    resolved: result.resolved,
    stillUnresolved: result.stillUnresolved,
    noSourceProvenance: result.noSourceProvenance,
  });

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.BACKFILL_OPPORTUNITY_FK,
    targetType: "opportunity",
    targetId: "opportunity-fk-backfill",
    after: {
      scanned: result.scanned,
      resolved: result.resolved,
      stillUnresolved: result.stillUnresolved,
      noSourceProvenance: result.noSourceProvenance,
    },
  });

  return result;
}
