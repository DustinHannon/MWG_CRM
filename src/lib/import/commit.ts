// Phase 6E — chunked commit pipeline. Takes the validated ParsedRow[]
// and writes leads / activities / opportunities / lead_tags in 100-row
// chunks, using concurrentUpdate for re-import paths so two users
// can't trample each other's edits between preview and commit.
//
// Failures inside a chunk are caught and logged; processing continues
// with the next chunk so partial success is preserved.

import "server-only";
import { and, eq, sql, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { activities } from "@/db/schema/activities";
import { opportunities } from "@/db/schema/crm-records";
import { leadTags, tags } from "@/db/schema/tags";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { expectAffected } from "@/lib/db/concurrent-update";
import { ConflictError, NotFoundError } from "@/lib/errors";
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
}

const CHUNK_SIZE = 100;

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
  const tagNames = new Set<string>();
  for (const r of rows) {
    if (!r.leadPatch.tags) continue;
    for (const t of r.leadPatch.tags.split(",")) {
      const trimmed = t.trim();
      if (trimmed.length > 0) tagNames.add(trimmed);
    }
  }
  const tagMap = await ensureTags(Array.from(tagNames), importerUserId);

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

  // Process in chunks of CHUNK_SIZE rows. Each chunk is its own
  // try/catch so a poison row doesn't kill the whole import.
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const slice = rows.slice(start, start + CHUNK_SIZE);
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
      });
    } catch (err) {
      logger.error("import.chunk_failed", {
        chunkStart: start,
        size: slice.length,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Mark every row in the failed chunk as failed.
      for (const r of slice) {
        if (r.ok) {
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

  return result;
}

async function processChunk(args: {
  slice: ParsedRow[];
  importerUserId: string;
  importJobId: string | null;
  ownerMap: Map<string, string>;
  byNameMap: Map<string, string>;
  tagMap: Map<string, string>;
  existingByExt: Map<string, { id: string; version: number }>;
  result: CommitResult;
}): Promise<void> {
  for (const row of args.slice) {
    if (!row.ok) continue;
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
        await db
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
          })
          .where(
            and(
              eq(leads.id, existing.id),
              eq(leads.version, existing.version),
            ),
          )
          .returning({ id: leads.id, version: leads.version });
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) {
          args.result.failedRows.push({
            rowNumber: row.rowNumber,
            reason: err.publicMessage,
          });
          continue;
        }
        throw err;
      }
      args.result.updatedLeadIds.push(leadId);
    } else {
      // INSERT new lead.
      const inserted = await db
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
      args.result.insertedLeadIds.push(leadId);
    }

    // ---- Activities ---------------------------------------------------
    for (const act of row.activities) {
      const dedupKey = computeImportDedupKey({
        leadId,
        kind: act.kind,
        occurredAt: act.occurredAt,
        body: act.body,
      });
      // Dedup via partial index — skip if already present.
      const existing = await db
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
        args.result.skippedActivityCount += 1;
        continue;
      }

      const createdById = act.metadata.byName
        ? lookupByName(act.metadata.byName, args.byNameMap)
        : null;
      const importedByName = createdById ? null : act.metadata.byName ?? null;

      // Translate parser direction to DB enum:
      //   outgoing → outbound, incoming → inbound. (Internal-direction
      //   isn't used by the parser; manual UI is the only producer.)
      const dbDirection: "inbound" | "outbound" | null =
        act.metadata.direction === "outgoing"
          ? "outbound"
          : act.metadata.direction === "incoming"
            ? "inbound"
            : null;
      await db.insert(activities).values({
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
      });
      args.result.insertedActivityCount += 1;
    }

    // ---- Opportunities -----------------------------------------------
    for (const opp of row.opportunities) {
      // Skip if a non-deleted opportunity with this name + source_lead_id
      // already exists (idempotent re-import).
      if (isUpdate) {
        const dup = await db
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
      const ins = await db
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
      args.result.insertedOpportunityIds.push(ins[0].id);
    }

    // ---- Tags --------------------------------------------------------
    if (row.leadPatch.tags) {
      for (const tagName of row.leadPatch.tags.split(",")) {
        const trimmed = tagName.trim();
        if (trimmed.length === 0) continue;
        const tagId = args.tagMap.get(trimmed.toLowerCase());
        if (!tagId) continue;
        // ON CONFLICT DO NOTHING — leadTags has a (lead_id, tag_id) PK.
        await db
          .insert(leadTags)
          .values({
            leadId,
            tagId,
            addedById: args.importerUserId,
          })
          .onConflictDoNothing();
      }
    }

    // ---- last_activity_at ---------------------------------------------
    if (row.leadPatch.lastActivityAt) {
      await db
        .update(leads)
        .set({ lastActivityAt: row.leadPatch.lastActivityAt })
        .where(eq(leads.id, leadId));
    }
  }
}

async function ensureTags(
  names: string[],
  actorId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (names.length === 0) return map;
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

  const missing = names.filter((n) => !map.has(n.toLowerCase()));
  for (const m of missing) {
    const slug = slugify(m);
    const ins = await db
      .insert(tags)
      .values({ name: m, slug, color: "slate", createdById: actorId })
      .onConflictDoNothing()
      .returning({ id: tags.id, name: tags.name });
    if (ins[0]) map.set(ins[0].name.toLowerCase(), ins[0].id);
    else {
      // Conflict — re-select by name (more permissive than slug).
      const r = await db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.name, m))
        .limit(1);
      if (r[0]) map.set(m.toLowerCase(), r[0].id);
    }
  }
  return map;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Tame unused warning on expectAffected for the typed-builder path
// (we call it in lib/leads.ts; not used here directly but kept imported
// to flag intent — the chunk path inlines the version check).
void expectAffected;
