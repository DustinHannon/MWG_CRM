// chunked commit pipeline. Takes the validated ParsedRow[]
// and writes leads / activities / opportunities / lead_tags in 100-row
// chunks. Each row commits in its own db.transaction so its lead and all
// of its children are atomic, and re-import UPDATEs are version-gated so
// two users can't trample each other's edits between preview and commit.
//
// A row that fails rolls back only itself and is reported as a single
// failed row; sibling rows and other chunks still commit, so partial
// success is preserved without partial-write corruption.

import "server-only";
import { and, eq, ilike, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { activities } from "@/db/schema/activities";
import { opportunities } from "@/db/schema/crm-records";
import { leadTags, tags } from "@/db/schema/tags";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { tagName } from "@/lib/validation/primitives";
import { computeImportDedupKey } from "./dedup-key";
import { lookupByName, resolveByNames, resolveOwnerEmails } from "./resolve-users";
import type { ParsedRow } from "./parse-row";

export interface CommitResult {
  insertedLeadIds: string[];
  updatedLeadIds: string[];
  insertedActivityCount: number;
  skippedActivityCount: number;
  insertedOpportunityIds: string[];
  failedRows: Array<{ rowNumber: number; reason: string }>;
  // Tag-application totals for the import audit summary. `tagsApplied`
  // is the number of new (lead, tag) pairs written to lead_tags
  // (ON CONFLICT DO NOTHING skips already-applied pairs). `tagsCreated`
  // is the number of new tag rows ensureTags inserted. `newTagIds`
  // are the ids of those new rows. Per the audit-event taxonomy, the
  // import emits one `tag.imported` row with these fields rather than
  // per-row `tag.applied`.
  tagsApplied: number;
  tagsCreated: number;
  newTagIds: string[];
}

const CHUNK_SIZE = 100;

// Drizzle's `db.transaction()` callback parameter is a PgTransaction
// which is not assignable to PostgresJsDatabase. We accept either the
// top-level `db` or the in-transaction `tx` on the per-row write path so
// each row's lead + activities + opportunities + tags commit or roll
// back as a unit. Mirrors the `Tx` alias in `@/lib/d365/commit-batch`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface CommitArgs {
  rows: ParsedRow[];
  importerUserId: string;
  importJobId?: string | null;
  importFileName?: string | null;
}

export async function commitImport({
  rows,
  importerUserId,
  importJobId = null,
  importFileName = null,
}: CommitArgs): Promise<CommitResult> {
  const result: CommitResult = {
    insertedLeadIds: [],
    updatedLeadIds: [],
    insertedActivityCount: 0,
    skippedActivityCount: 0,
    insertedOpportunityIds: [],
    failedRows: [],
    tagsApplied: 0,
    tagsCreated: 0,
    newTagIds: [],
  };

  // Resolve owner emails + opportunity-owner emails + activity By-names
  // up-front in two batched queries.
  const ownerEmails = new Set<string>();
  const byNames = new Set<string>();
  for (const r of rows) {
    if (r.leadPatch.ownerEmail) ownerEmails.add(r.leadPatch.ownerEmail);
    for (const o of r.opportunities) {
      if (o.ownerEmail) ownerEmails.add(o.ownerEmail);
    }
    for (const a of r.activities) {
      if (a.metadata.byName) byNames.add(a.metadata.byName);
    }
  }
  const ownerMap = await resolveOwnerEmails(ownerEmails);
  const byNameMap = await resolveByNames(byNames);

  // Tag autocreate — collect distinct names and ensure tags rows exist.
  // every candidate is validated through
  // the `tagName` primitive (length + charset). Failures are logged
  // (row + reason) and the offending tag is dropped; the rest of the
  // row's tags still go through. Keeps junk like raw HTML, 200-char
  // pasted blobs, or control chars out of the tags table.
  const tagNames = new Set<string>();
  for (const r of rows) {
    if (!r.ok) continue;
    if (!r.leadPatch.tags) continue;
    for (const t of r.leadPatch.tags.split(",")) {
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      const parsed = tagName.safeParse(trimmed);
      if (!parsed.success) {
        logger.warn("import.tag_rejected", {
          rowNumber: r.rowNumber,
          tagPreview: trimmed.slice(0, 60),
          reason: parsed.error.issues[0]?.message ?? "invalid",
        });
        continue;
      }
      tagNames.add(parsed.data);
    }
  }
  const ensured = await ensureTags(Array.from(tagNames), importerUserId);
  const tagMap = ensured.map;
  result.tagsCreated = ensured.newTagIds.length;
  result.newTagIds = ensured.newTagIds;

  // External-ID lookup for re-import.
  const externalIds = rows
    .map((r) => r.leadPatch.externalId)
    .filter((v): v is string => Boolean(v));
  const existingByExt = new Map<
    string,
    { id: string; version: number }
  >();
  if (externalIds.length > 0) {
    const existing = await db
      .select({
        id: leads.id,
        externalId: leads.externalId,
        version: leads.version,
      })
      .from(leads)
      .where(
        and(
          inArray(leads.externalId, externalIds),
          eq(leads.isDeleted, false),
        ),
      );
    for (const e of existing) {
      if (e.externalId) existingByExt.set(e.externalId, { id: e.id, version: e.version });
    }
  }

  // Process in chunks of CHUNK_SIZE rows. Each row commits in its own
  // transaction (see processChunk), so a poison row rolls back only
  // itself. The outer try/catch is a defense-in-depth net for a
  // catastrophic whole-chunk failure (e.g. the transaction layer itself
  // becoming unusable) — it marks only rows that processChunk has NOT
  // already reached a terminal state for, so committed/failed rows are
  // never double-counted.
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const slice = rows.slice(start, start + CHUNK_SIZE);
    const processedRows = new Set<number>();
    try {
      await processChunk({
        slice,
        importerUserId,
        importJobId,
        ownerMap,
        byNameMap,
        tagMap,
        existingByExt,
        result,
        processedRows,
      });
    } catch (err) {
      logger.error("import.chunk_failed", {
        chunkStart: start,
        size: slice.length,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Mark only rows not already accounted for (committed, deduped, or
      // individually failed) as failed — rows processChunk already
      // resolved keep their real outcome.
      for (const r of slice) {
        if (r.ok && !processedRows.has(r.rowNumber)) {
          result.failedRows.push({
            rowNumber: r.rowNumber,
            reason:
              err instanceof Error
                ? err.message
                : "Unknown chunk failure",
          });
        }
      }
    }
  }

  // One audit row per import describing the whole commit. Forensic gold
  // for "what did that import actually do."
  await writeAudit({
    actorId: importerUserId,
    action: "import.commit",
    targetType: "import_job",
    targetId: importJobId ?? "ad-hoc",
    after: {
      fileName: importFileName,
      totalRows: rows.length,
      inserted: result.insertedLeadIds.length,
      updated: result.updatedLeadIds.length,
      activitiesInserted: result.insertedActivityCount,
      activitiesSkipped: result.skippedActivityCount,
      opportunitiesInserted: result.insertedOpportunityIds.length,
      failedRows: result.failedRows.length,
    },
  });

  // Tag-application summary. One audit row per import (not per row) so
  // tag.applied events don't flood the audit log for large imports.
  // Only emitted when the run actually touched tags — silent no-op
  // otherwise.
  if (result.tagsApplied > 0 || result.tagsCreated > 0) {
    await writeAudit({
      actorId: importerUserId,
      action: "tag.imported",
      targetType: "import_job",
      targetId: importJobId ?? "ad-hoc",
      after: {
        entityType: "lead",
        jobId: importJobId ?? null,
        tagsApplied: result.tagsApplied,
        tagsCreated: result.tagsCreated,
        newTagIds: result.newTagIds,
      },
    });
  }

  return result;
}

// Per-row commit outcome, accumulated INSIDE the row's transaction and
// only folded into the shared CommitResult AFTER that transaction
// commits. This is what makes the chunk catch honest: a row is counted
// inserted/updated only once its writes are durable, so a mid-row throw
// rolls back its partial writes and the row is reported failed — never
// both written and "failed".
interface CommittedOutcome {
  kind: "committed";
  insertedLeadId?: string;
  updatedLeadId?: string;
  insertedActivityCount: number;
  skippedActivityCount: number;
  insertedOpportunityIds: string[];
  tagsApplied: number;
}

type RowOutcome =
  | CommittedOutcome
  // OCC conflict / not-found on a re-import UPDATE: the transaction made
  // no writes and commits cleanly. The reason is recorded as a failed row
  // by the caller AFTER the transaction resolves, so result mutations
  // never happen inside an open transaction.
  | { kind: "conflict"; reason: string };

async function processChunk(args: {
  slice: ParsedRow[];
  importerUserId: string;
  importJobId: string | null;
  ownerMap: Map<string, string>;
  byNameMap: Map<string, string>;
  tagMap: Map<string, string>;
  existingByExt: Map<string, { id: string; version: number }>;
  result: CommitResult;
  // Row numbers that have reached a terminal state (committed, deduped,
  // OCC-conflict, or individually failed). The outer chunk catch consults
  // this so a catastrophic whole-chunk failure only fails the remainder.
  processedRows: Set<number>;
}): Promise<void> {
  for (const row of args.slice) {
    if (!row.ok) continue;
    // Each row commits as its own transaction so its lead + activities +
    // opportunities + tags are atomic. A failure inside the row rolls the
    // row back and is reported as a single failed row; sibling rows in the
    // chunk are unaffected. The shared result is mutated only after commit.
    try {
      const outcome = await db.transaction((tx) =>
        commitRow({ ...args, row, tx }),
      );
      if (outcome.kind === "conflict") {
        // OCC conflict / not-found: the row's transaction made no writes
        // and committed cleanly. Record it as a failed row now, after the
        // transaction resolved.
        args.result.failedRows.push({
          rowNumber: row.rowNumber,
          reason: outcome.reason,
        });
        args.processedRows.add(row.rowNumber);
        continue;
      }
      if (outcome.insertedLeadId)
        args.result.insertedLeadIds.push(outcome.insertedLeadId);
      if (outcome.updatedLeadId)
        args.result.updatedLeadIds.push(outcome.updatedLeadId);
      args.result.insertedActivityCount += outcome.insertedActivityCount;
      args.result.skippedActivityCount += outcome.skippedActivityCount;
      args.result.insertedOpportunityIds.push(...outcome.insertedOpportunityIds);
      args.result.tagsApplied += outcome.tagsApplied;
      args.processedRows.add(row.rowNumber);
    } catch (err) {
      // Any unexpected error rolled the row's transaction back, so no
      // partial writes survive. Report exactly this row as failed and
      // continue with the next row.
      logger.error("import.row_failed", {
        rowNumber: row.rowNumber,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      args.result.failedRows.push({
        rowNumber: row.rowNumber,
        reason: err instanceof Error ? err.message : "Unknown row failure",
      });
      args.processedRows.add(row.rowNumber);
    }
  }
}

// Commits a single validated row inside an open transaction `tx`.
// Returns a `committed` outcome with the row's write counts on success,
// or a `conflict` outcome when an OCC conflict / not-found made the
// re-import UPDATE a no-op (the transaction made no writes and commits
// cleanly; the caller records the failed row after it resolves). Any
// other throw propagates so the caller rolls the transaction back and
// marks the row failed.
async function commitRow(args: {
  row: ParsedRow;
  tx: Tx;
  importerUserId: string;
  importJobId: string | null;
  ownerMap: Map<string, string>;
  byNameMap: Map<string, string>;
  tagMap: Map<string, string>;
  existingByExt: Map<string, { id: string; version: number }>;
}): Promise<RowOutcome> {
  const { row, tx } = args;
  const outcome: CommittedOutcome = {
    kind: "committed",
    insertedActivityCount: 0,
    skippedActivityCount: 0,
    insertedOpportunityIds: [],
    tagsApplied: 0,
  };
  {
    const ownerId = row.leadPatch.ownerEmail
      ? args.ownerMap.get(row.leadPatch.ownerEmail) ?? null
      : args.importerUserId;

    let leadId: string;
    let isUpdate = false;

    const existing = row.leadPatch.externalId
      ? args.existingByExt.get(row.leadPatch.externalId)
      : undefined;

    if (existing) {
      isUpdate = true;
      leadId = existing.id;
      try {
        // re-import UPDATE is version-gated: a stale `version` produces a
        // 0-row update, which the inline check below turns into a real
        // ConflictError instead of silently no-op'ing while the row id got
        // pushed to updatedLeadIds. lastActivityAt is folded into the same
        // UPDATE so we don't burn a second un-versioned write for it.
        const updateRows = await tx
          .update(leads)
          .set({
            ownerId,
            firstName: row.leadPatch.firstName,
            lastName: row.leadPatch.lastName ?? null,
            email: row.leadPatch.email ?? null,
            phone: row.leadPatch.phone ?? null,
            mobilePhone: row.leadPatch.mobilePhone ?? null,
            jobTitle: row.leadPatch.jobTitle ?? null,
            companyName: row.leadPatch.companyName ?? null,
            industry: row.leadPatch.industry ?? null,
            website: row.leadPatch.website ?? null,
            linkedinUrl: row.leadPatch.linkedinUrl ?? null,
            street1: row.leadPatch.street1 ?? null,
            street2: row.leadPatch.street2 ?? null,
            city: row.leadPatch.city ?? null,
            state: row.leadPatch.state ?? null,
            postalCode: row.leadPatch.postalCode ?? null,
            country: row.leadPatch.country ?? null,
            status: row.leadPatch.status,
            rating: row.leadPatch.rating,
            source: row.leadPatch.source,
            estimatedValue:
              row.leadPatch.estimatedValue !== null && row.leadPatch.estimatedValue !== undefined
                ? row.leadPatch.estimatedValue.toFixed(2)
                : null,
            estimatedCloseDate: row.leadPatch.estimatedCloseDate
              ? row.leadPatch.estimatedCloseDate.toISOString().slice(0, 10)
              : null,
            subject: row.leadPatch.subject ?? null,
            description: row.leadPatch.description ?? null,
            doNotContact: row.leadPatch.doNotContact,
            doNotEmail: row.leadPatch.doNotEmail,
            doNotCall: row.leadPatch.doNotCall,
            updatedById: args.importerUserId,
            updatedAt: sql`now()`,
            version: sql`${leads.version} + 1`,
            // Fold last_activity_at into the OCC'd update — was a
            // separate un-versioned write previously (F-027).
            ...(row.leadPatch.lastActivityAt
              ? { lastActivityAt: row.leadPatch.lastActivityAt }
              : {}),
          })
          .where(
            and(
              eq(leads.id, existing.id),
              eq(leads.version, existing.version),
              eq(leads.isDeleted, false),
            ),
          )
          .returning({ id: leads.id, version: leads.version });
        // Inline the affected-rows check against the open transaction
        // `tx`. We can't reuse `expectAffected` here: it issues its
        // existence probe on the top-level `db`, and with the
        // pool's `max: 1` a second `db` query while this transaction
        // holds the only connection would deadlock. A 0-row update means
        // the row's `version` moved or it was deleted between preview and
        // commit — both are concurrent-modification cases, reported as a
        // ConflictError; a genuinely absent row is a NotFoundError.
        if (updateRows.length === 0) {
          const stillExists = await tx
            .select({ id: leads.id })
            .from(leads)
            .where(eq(leads.id, existing.id))
            .limit(1);
          if (stillExists.length === 0) {
            throw new NotFoundError("lead");
          }
          throw new ConflictError(
            "This record was modified by someone else. Refresh to see their changes, then try again.",
            { id: existing.id },
          );
        }
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) {
          // Re-import OCC conflict / not-found made this a no-op (no
          // writes), so the transaction can commit cleanly. Signal the
          // caller to record the row as failed once the tx resolves.
          return { kind: "conflict", reason: err.publicMessage };
        }
        throw err;
      }
      outcome.updatedLeadId = leadId;
    } else {
      // INSERT new lead.
      const inserted = await tx
        .insert(leads)
        .values({
          ownerId,
          firstName: row.leadPatch.firstName,
          lastName: row.leadPatch.lastName ?? null,
          email: row.leadPatch.email ?? null,
          phone: row.leadPatch.phone ?? null,
          mobilePhone: row.leadPatch.mobilePhone ?? null,
          jobTitle: row.leadPatch.jobTitle ?? null,
          companyName: row.leadPatch.companyName ?? null,
          industry: row.leadPatch.industry ?? null,
          website: row.leadPatch.website ?? null,
          linkedinUrl: row.leadPatch.linkedinUrl ?? null,
          street1: row.leadPatch.street1 ?? null,
          street2: row.leadPatch.street2 ?? null,
          city: row.leadPatch.city ?? null,
          state: row.leadPatch.state ?? null,
          postalCode: row.leadPatch.postalCode ?? null,
          country: row.leadPatch.country ?? null,
          status: row.leadPatch.status,
          rating: row.leadPatch.rating,
          source: row.leadPatch.source,
          estimatedValue:
            row.leadPatch.estimatedValue !== null && row.leadPatch.estimatedValue !== undefined
              ? row.leadPatch.estimatedValue.toFixed(2)
              : null,
          estimatedCloseDate: row.leadPatch.estimatedCloseDate
            ? row.leadPatch.estimatedCloseDate.toISOString().slice(0, 10)
            : null,
          subject: row.leadPatch.subject ?? null,
          description: row.leadPatch.description ?? null,
          doNotContact: row.leadPatch.doNotContact,
          doNotEmail: row.leadPatch.doNotEmail,
          doNotCall: row.leadPatch.doNotCall,
          externalId: row.leadPatch.externalId ?? null,
          createdById: args.importerUserId,
          updatedById: args.importerUserId,
          createdVia: "imported",
          importJobId: args.importJobId ?? null,
        })
        .returning({ id: leads.id });
      leadId = inserted[0].id;
      outcome.insertedLeadId = leadId;
    }

    // ---- Activities ---------------------------------------------------
    for (const act of row.activities) {
      const dedupKey = computeImportDedupKey({
        leadId,
        kind: act.kind,
        occurredAt: act.occurredAt,
        body: act.body,
      });
      // Cheap pre-check via the (lead_id, import_dedup_key) index — skips
      // the INSERT for the common sequential re-import case. The INSERT
      // below carries an ON CONFLICT DO NOTHING on the same partial-unique
      // index, so this is an optimization, not the integrity guard: two
      // concurrent imports that both pass this SELECT are still
      // de-duplicated atomically at INSERT time.
      const existing = await tx
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            eq(activities.leadId, leadId),
            eq(activities.importDedupKey, dedupKey),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        outcome.skippedActivityCount += 1;
        continue;
      }

      const createdById = act.metadata.byName
        ? lookupByName(act.metadata.byName, args.byNameMap)
        : null;
      const importedByName = createdById ? null : act.metadata.byName ?? null;

      // Translate parser direction to DB enum:
      // outgoing → outbound, incoming → inbound. (Internal-direction
      // isn't used by the parser; manual UI is the only producer.)
      const dbDirection: "inbound" | "outbound" | null =
        act.metadata.direction === "outgoing"
          ? "outbound"
          : act.metadata.direction === "incoming"
            ? "inbound"
            : null;
      // ON CONFLICT DO NOTHING on the partial-unique
      // (lead_id, import_dedup_key) index makes dedup atomic instead of
      // check-then-act: a concurrent import that wrote the same activity
      // between our SELECT and INSERT is skipped here rather than
      // duplicated. .returning() distinguishes a real insert (one row)
      // from a deduped skip (zero rows).
      const insertedAct = await tx
        .insert(activities)
        .values({
          leadId,
          kind: act.kind,
          direction: dbDirection,
          subject: act.subject ?? null,
          body: act.body || null,
          occurredAt: act.occurredAt,
          durationMinutes: act.metadata.durationMin ?? null,
          outcome: act.metadata.outcome ?? null,
          meetingAttendees:
            act.kind === "meeting" && act.metadata.attendees
              ? act.metadata.attendees.map((name) => ({ name }))
              : null,
          userId: createdById,
          importedByName,
          importDedupKey: dedupKey,
        })
        .onConflictDoNothing({
          target: [activities.leadId, activities.importDedupKey],
          // Matches the partial-unique index predicate so Postgres uses
          // activities_import_dedup_idx as the arbiter.
          where: sql`import_dedup_key IS NOT NULL`,
        })
        .returning({ id: activities.id });
      if (insertedAct.length > 0) {
        outcome.insertedActivityCount += 1;
      } else {
        outcome.skippedActivityCount += 1;
      }
    }

    // ---- Opportunities -----------------------------------------------
    for (const opp of row.opportunities) {
      // Skip if a non-deleted opportunity with this name + source_lead_id
      // already exists (idempotent re-import).
      if (isUpdate) {
        const dup = await tx
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(
            and(
              eq(opportunities.sourceLeadId, leadId),
              eq(opportunities.name, opp.name),
              eq(opportunities.isDeleted, false),
            ),
          )
          .limit(1);
        if (dup.length > 0) continue;
      }
      const oppOwnerId = opp.ownerEmail
        ? args.ownerMap.get(opp.ownerEmail) ?? null
        : opp.ownerName
          ? lookupByName(opp.ownerName, args.byNameMap)
          : null;
      const stageValue = opp.stage as
        | "prospecting"
        | "qualification"
        | "proposal"
        | "negotiation"
        | "closed_won"
        | "closed_lost";
      const ins = await tx
        .insert(opportunities)
        .values({
          name: opp.name,
          stage: stageValue,
          probability: opp.probability ?? null,
          amount:
            opp.amount !== null && opp.amount !== undefined
              ? opp.amount.toFixed(2)
              : null,
          ownerId: oppOwnerId,
          sourceLeadId: leadId,
          description: opp.description ?? null,
          createdById: args.importerUserId,
          // No accountId — imports create lead-only opportunities.
          // The lead-conversion flow links them later.
        })
        .returning({ id: opportunities.id });
      outcome.insertedOpportunityIds.push(ins[0].id);
    }

    // ---- Tags --------------------------------------------------------
    if (row.leadPatch.tags) {
      for (const candidate of row.leadPatch.tags.split(",")) {
        const trimmed = candidate.trim();
        if (trimmed.length === 0) continue;
        // re-run primitive here too. If the
        // string was rejected at the upstream Set-build step, the
        // tagMap won't have an entry and we silently skip; this mirrors
        // that without re-warning per row.
        const parsed = tagName.safeParse(trimmed);
        if (!parsed.success) continue;
        const tagId = args.tagMap.get(parsed.data.toLowerCase());
        if (!tagId) continue;
        // ON CONFLICT DO NOTHING — leadTags has a (lead_id, tag_id) PK.
        // .returning() tells us whether the row was actually inserted
        // vs. skipped as a duplicate, so the import audit can report
        // accurate `tagsApplied` counts.
        const ins = await tx
          .insert(leadTags)
          .values({
            leadId,
            tagId,
            addedById: args.importerUserId,
          })
          .onConflictDoNothing()
          .returning({ leadId: leadTags.leadId });
        if (ins.length > 0) outcome.tagsApplied += 1;
      }
    }

    // ---- last_activity_at ---------------------------------------------
    // for re-imports we already folded
    // lastActivityAt into the OCC-checked UPDATE above. For freshly
    // INSERTed leads the value is set here; the row was just created,
    // so there is no concurrent writer to race with and a non-versioned
    // UPDATE is safe.
    if (!isUpdate && row.leadPatch.lastActivityAt) {
      await tx
        .update(leads)
        .set({ lastActivityAt: row.leadPatch.lastActivityAt })
        .where(eq(leads.id, leadId));
    }
  }
  return outcome;
}

async function ensureTags(
  names: string[],
  actorId: string,
): Promise<{ map: Map<string, string>; newTagIds: string[] }> {
  const map = new Map<string, string>();
  const newTagIds: string[] = [];
  if (names.length === 0) return { map, newTagIds };
  const lower = names.map((n) => n.toLowerCase());
  const existing = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(
      sql`lower(${tags.name}) IN (${sql.join(
        lower.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
  for (const e of existing) map.set(e.name.toLowerCase(), e.id);

  // Auto-created tags get a palette colour rotated by position so
  // freshly-imported batches don't all land as `slate`. Matches the
  // `nextDefaultPaletteColor` helper in `@/components/tags/helpers`
  // — replicated as a string array here to avoid a client-bundle
  // helper import inside the server-only commit pipeline.
  const PALETTE = [
    "slate",
    "navy",
    "blue",
    "teal",
    "green",
    "amber",
    "gold",
    "orange",
    "rose",
    "violet",
    "gray",
  ] as const;
  // Seed the rotation from the count of existing tags so new imports
  // continue where the prior set left off rather than always starting
  // at slate. countAll is cheap (small table, indexed PK).
  const [{ count: totalTags = 0 } = { count: 0 }] = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tags)) as Array<{ count: number }>;
  let rotation = totalTags;

  const missing = names.filter((n) => !map.has(n.toLowerCase()));
  for (const m of missing) {
    const slug = slugify(m);
    const color = PALETTE[rotation % PALETTE.length];
    rotation += 1;
    const ins = await db
      .insert(tags)
      .values({ name: m, slug, color, createdById: actorId })
      .onConflictDoNothing()
      .returning({ id: tags.id, name: tags.name });
    if (ins[0]) {
      map.set(ins[0].name.toLowerCase(), ins[0].id);
      newTagIds.push(ins[0].id);
    } else {
      // Conflict — case-INSENSITIVE re-select. The conflict could be
      // on the slug (e.g. "Hot-Lead" and "hot lead" both slugify to
      // "hot-lead") which means the existing tag's name may differ
      // in case or whitespace from the import row's name. A
      // case-sensitive `eq(tags.name, m)` would miss the existing row
      // and silently drop the tag from the map — records that
      // referenced this tag would import without it. ilike on the
      // name reliably finds the colliding row regardless of case.
      const r = await db
        .select({ id: tags.id })
        .from(tags)
        .where(ilike(tags.name, m))
        .limit(1);
      if (r[0]) map.set(m.toLowerCase(), r[0].id);
    }
  }
  return { map, newTagIds };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
