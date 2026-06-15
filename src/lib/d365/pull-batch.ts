import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  ConflictError,
  KnownError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { D365_AUDIT_EVENTS, D365_HALT_REASONS } from "./audit-events";
import { D365HttpError } from "./with-retry";
import { getD365Client, type D365Client } from "./client";
import {
  fetchAnnotationsForRoots,
  fetchAppointmentsForRoots,
  fetchEmailsForRoots,
  fetchPhonecallsForRoots,
  fetchRootByType,
  fetchTasksForRoots,
  isD365RootType,
  type AnnotationRootType,
  type BaseFetchOpts,
  type ChildFetchResult,
  type D365RootType,
  type FetchPageResult,
} from "./queries";
import { broadcastRunEvent } from "./realtime-broadcast";
import {
  D365_ENTITY_PK,
  type D365EntityType,
  type D365SystemUser,
} from "./types";

/**
 * orchestrator that pulls one batch (≤100 ROOT records) of an import
 * run from D365, drains each root's full child graph, and persists it
 * for human review — the ROOT-AGGREGATE model.
 *
 * The unit of work is one ROOT entity (lead | contact | account |
 * opportunity) WITH its full child graph (task / phonecall /
 * appointment / email / annotation). Children are NEVER pulled
 * standalone — they always travel with their root. One `import_records`
 * row is persisted per ROOT, carrying its children nested under
 * `rawPayload.children`. This makes the graph commit atomic per root
 * downstream and removes the dangling-relationship class of defects
 * entirely.
 *
 * Originated opportunities (a lead's `_originatingleadid_value` graft)
 * are NOT pulled here: opportunity is itself a root type (in
 * `D365_ROOT_TYPES`) and imports via its own opportunity root run, so
 * grafting it onto a lead pull only duplicated the fetch and exposed the
 * truncation halt on data that was never mapped or committed.
 *
 * Flow:
 *
 * 1. Acquire transaction-scoped advisory lock on the run id so a
 *    double-clicked "Pull next batch" can't double-pull.
 * 2. Load the run; assert status ∈ {created, fetching, reviewing} and
 *    entityType is one of the FOUR root types (children rejected).
 * 3. Reserve the next `import_batches` row (status='pending') with
 *    monotonic `batch_number` per run.
 * 4. Broadcast `fetching.started` → fetch one page of ROOT records →
 *    collect their GUIDs → drain every child collection (or-chains on
 *    the parent reference) → group children to parents in memory →
 *    broadcast `fetching.progress` → persist one `import_records` row
 *    per root + update batch + update run cursor.
 * 5. If any child collection reports `truncated` (its 50k hard cap was
 *    hit before the collection drained), HALT the run rather than lose
 *    call history — transition to `paused_for_review`, append note,
 *    emit `RUN_HALTED`, broadcast `halted`, throw a typed error.
 * 6. On D365 fetch failure after retry exhaustion (`D365HttpError`):
 *    same halt path with reason `D365_UNREACHABLE`.
 *
 * Returns `{ batchId, recordCount, nextCursor }`. `recordCount` is the
 * number of ROOT records persisted this page. `nextCursor` is the
 * server-supplied OData @odata.nextLink for the *next* page of ROOTS,
 * or null when this was the final page (run transitions to `mapping`).
 *
 * Concurrency: pg_advisory_xact_lock is held for the duration of the
 * transaction we open around the lock acquisition. The transaction
 * commits after we've reserved the batch row — the actual D365 fetch
 * (root page + child drain) happens OUTSIDE the lock so a slow Dynamics
 * call doesn't block a concurrent admin operating on a different run. A
 * second worker for the SAME run blocks on the lock until the first
 * commits its reservation, then sees the new cursor and pulls the next
 * page (idempotent by design).
 */

export interface PullBatchResult {
  batchId: string;
  batchNumber: number;
  recordCount: number;
  nextCursor: string | null;
  /** True when the underlying ROOT query reports no further pages. */
  isFinalPage: boolean;
}

interface RunRow {
  id: string;
  status: typeof importRuns.$inferSelect.status;
  entityType: string;
  scope: unknown;
  cursor: string | null;
  notes: string | null;
}

const ALLOWED_PULL_STATUSES = new Set<RunRow["status"]>([
  "created",
  "fetching",
  "reviewing",
]);

interface RunScope {
  filter?: {
    modifiedSince?: string;
    statecode?: number[];
    ids?: string[];
  };
  expand?: boolean | string[];
  includeChildren?: boolean;
  /**
   * Per-run root page size (also the child-collection page size). Absent
   * on a fresh run (defaults to 100). The child-collection-truncation
   * halt HALVES this (floor 1) so the offending page shrinks until each
   * child collection drains under the hard cap; threaded through every
   * subsequent pull.
   */
  rootPageSize?: number;
}

/**
 * Nested raw child arrays grouped to one root. Mirrors `D365Children`
 * from `./mapping/children` (the map slice reads these keys). Only keys
 * with at least one child are set — a root with no children of a type
 * omits the key.
 */
interface RawChildren {
  task?: Record<string, unknown>[];
  phonecall?: Record<string, unknown>[];
  appointment?: Record<string, unknown>[];
  email?: Record<string, unknown>[];
  annotation?: Record<string, unknown>[];
}

/**
 * Per-root persisted shape under `import_records.rawPayload`. `root` is
 * the raw D365 root record (owner-enriched); `children` holds the
 * stitched child arrays; `_sourceOwnerId` carries the source
 * `_ownerid_value` GUID verbatim for attribution recovery (there is no
 * `metadata` column on `import_records`, so the provenance rides on the
 * payload).
 */
interface RootAggregatePayload {
  root: Record<string, unknown>;
  children: RawChildren;
  _sourceOwnerId: string | null;
}

/**
 * Pull and persist the next batch for a run. Caller is responsible for
 * `withErrorBoundary` wrapping (this is a lib helper — it throws
 * KnownError subclasses on app-domain failures).
 */
export async function pullNextBatch(
  runId: string,
  actorId: string,
): Promise<PullBatchResult> {
  if (!runId) throw new ValidationError("runId is required.");
  if (!actorId) throw new ValidationError("actorId is required.");

  // reserve a batch row under advisory lock + return cursor.
  const reservation = await reserveNextBatch(runId);
  const { batchId, batchNumber, run } = reservation;

  // reserveNextBatch already asserted the run's entityType is a root
  // type; narrow it here so the child-drain dispatch is type-safe.
  const rootType = run.entityType as D365RootType;

  await broadcastRunEvent(runId, "fetching.started", {
    batchId,
    batchNumber,
    entityType: rootType,
  });

  // fetch from D365 OUTSIDE the lock.
  const client = getD365Client();
  const fetchOpts = scopeToFetchOpts(run.scope, run.cursor);

  // --- 1. ROOT page -------------------------------------------------------
  let rootPage: FetchPageResult<unknown>;
  try {
    rootPage = await fetchRootByType(client, rootType, fetchOpts);
  } catch (err) {
    await handleFetchFailure(runId, batchId, actorId, rootType, err);
    // handleFetchFailure throws — unreachable, keeps flow analysis honest.
    throw err;
  }

  const roots = rootPage.records
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  const nextLink = rootPage.nextLink ?? null;
  const isFinalPage = !nextLink;

  // Enrich each raw ROOT with its owner's Entra UPN under the synthetic
  // `_ownerid_value_email` key BEFORE persist. The $select allowlists
  // only request the owner GUID (`_ownerid_value`); without this the
  // map-batch owner resolver can never resolve a real owner and every
  // record falls back to the default owner. Children are enriched in the
  // same single batched lookup once they're collected (below).
  await enrichOwnerEmails(client, roots, {
    runId,
    batchId,
    entityType: rootType,
  });

  // --- 2. Collect root GUIDs + drain the child graph ----------------------
  const rootPk = D365_ENTITY_PK[rootType];
  const rootIds: string[] = [];
  for (const root of roots) {
    const id = root[rootPk];
    if (typeof id === "string" && id.length > 0) rootIds.push(id);
  }

  // The per-run root page size also bounds each child collection's page
  // size, so the truncation-halt shrink (which halves this) makes the
  // offending page smaller on the next pull until each child collection
  // drains under the hard cap.
  const rootPageSize = fetchOpts.top ?? 100;

  let children: DrainedChildren;
  try {
    children = await drainChildGraph(
      client,
      rootType,
      rootIds,
      fetchOpts.signal,
      rootPageSize,
    );
  } catch (err) {
    // A child-collection fetch that fails after retry exhaustion is the
    // same H-1 D365-unreachable condition as the root fetch — halt with
    // the same reason rather than commit a root graph missing its
    // history.
    await handleFetchFailure(runId, batchId, actorId, rootType, err);
    throw err;
  }

  // Any truncated child collection means the 50k hard cap was hit before
  // the collection drained — we would silently lose call history. HALT
  // the run (reuse the fetch-time halt machinery) rather than persist a
  // lossy graph.
  const truncatedKinds = collectTruncatedKinds(children);
  if (truncatedKinds.length > 0) {
    await handleChildTruncation(
      runId,
      batchId,
      actorId,
      rootType,
      truncatedKinds,
      run.scope,
      rootPageSize,
    );
    // handleChildTruncation throws — unreachable.
    throw new Error("invariant: handleChildTruncation did not throw");
  }

  // Enrich child owners in a single batched lookup (same synthetic
  // `_ownerid_value_email` key) so the map slice can resolve each
  // child's real owner instead of always inheriting the root's.
  const allChildren = [
    ...children.task.records,
    ...children.phonecall.records,
    ...children.appointment.records,
    ...children.email.records,
    ...children.annotation.records,
  ];
  await enrichOwnerEmails(client, allChildren, {
    runId,
    batchId,
    entityType: rootType,
  });

  // --- 3. Group children to parents in memory -----------------------------
  // Keyed by LOWERCASE root GUID — the persist loop looks up by
  // `sourceId.toLowerCase()` so a root-PK / child-lookup case mismatch
  // can never silently drop a child.
  const grouped = groupChildrenByParent(children);

  await broadcastRunEvent(runId, "fetching.progress", {
    batchId,
    batchNumber,
    fetched: roots.length,
    childrenFetched: allChildren.length,
    nextLinkPresent: Boolean(nextLink),
  });

  // --- 4. Persist one import_records row per ROOT -------------------------
  await db.transaction(async (tx) => {
    if (roots.length > 0) {
      await tx.insert(importRecords).values(
        roots.map((root) => {
          const sourceId = String(root[rootPk] ?? "");
          if (!sourceId) {
            // Defensive — we've selected the PK column explicitly so
            // this should never fire. Log + carry on with empty string
            // so the row still persists and the reviewer can raise it
            // manually.
            logger.error("d365.pull.missing_source_id", {
              runId,
              batchId,
              entityType: rootType,
              pkColumn: rootPk,
            });
          }
          const ownerId = root["_ownerid_value"];
          const payload: RootAggregatePayload = {
            root,
            // grouped is keyed by LOWERCASE root GUID (see
            // groupChildrenByParent) — look up by the lowercased sourceId.
            children: grouped.get(sourceId.toLowerCase()) ?? {},
            _sourceOwnerId: typeof ownerId === "string" ? ownerId : null,
          };
          return {
            batchId,
            sourceEntityType: rootType,
            sourceId,
            rawPayload: payload as unknown as Record<string, unknown>,
            status: "pending" as const,
          };
        }),
      );
    }

    await tx
      .update(importBatches)
      .set({
        status: "fetched",
        fetchedAt: sql`now()`,
        recordCountFetched: roots.length,
      })
      .where(eq(importBatches.id, batchId));

    await tx
      .update(importRuns)
      .set({
        cursor: nextLink,
        status: isFinalPage ? "mapping" : "fetching",
      })
      .where(eq(importRuns.id, runId));
  });

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.BATCH_FETCHED,
    targetType: "import_batch",
    targetId: batchId,
    after: {
      runId,
      entityType: rootType,
      batchNumber,
      recordCount: roots.length,
      childrenFetched: allChildren.length,
      cursorAdvanced: Boolean(nextLink),
      isFinalPage,
    },
  });

  await broadcastRunEvent(runId, "fetching.completed", {
    batchId,
    batchNumber,
    recordCount: roots.length,
    childrenFetched: allChildren.length,
    isFinalPage,
  });

  logger.info("d365.pull_batch.completed", {
    runId,
    batchId,
    batchNumber,
    entityType: rootType,
    recordCount: roots.length,
    childrenFetched: allChildren.length,
    isFinalPage,
  });

  return {
    batchId,
    batchNumber,
    recordCount: roots.length,
    nextCursor: nextLink,
    isFinalPage,
  };
}

/* -------------------------------------------------------------------------- *
 * Reservation under lock *
 * -------------------------------------------------------------------------- */

async function reserveNextBatch(runId: string): Promise<{
  batchId: string;
  batchNumber: number;
  run: RunRow;
}> {
  return db.transaction(async (tx) => {
    // Transaction-scoped advisory lock per run id. `hashtext` -> int4
    // and the namespaced prefix avoids collisions with other features.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`d365.run.${runId}`}))`,
    );

    const [run] = await tx
      .select({
        id: importRuns.id,
        status: importRuns.status,
        entityType: importRuns.entityType,
        scope: importRuns.scope,
        cursor: importRuns.cursor,
        notes: importRuns.notes,
      })
      .from(importRuns)
      .where(eq(importRuns.id, runId))
      .limit(1);

    if (!run) throw new NotFoundError("import run");

    if (!ALLOWED_PULL_STATUSES.has(run.status)) {
      throw new ConflictError(
        `Run is in status '${run.status}' and cannot accept a new batch.`,
        { status: run.status },
      );
    }

    // ROOT-AGGREGATE: only the four root types are valid units of work.
    // Children (task/phonecall/appointment/email/annotation) are NEVER
    // pulled standalone — they travel with their root. A run created for
    // a child type is a misconfiguration; reject it before any fetch.
    if (!isD365RootType(run.entityType as D365EntityType)) {
      throw new ValidationError(
        `D365 import runs must root on lead, contact, account, or opportunity; got '${run.entityType}'.`,
      );
    }

    // Compute next batch_number: max(batch_number) + 1 within run, or 1.
    const [{ next }] = await tx.execute<{ next: number }>(
      sql`select coalesce(max(batch_number), 0) + 1 as next from import_batches where run_id = ${runId}`,
    );
    const batchNumber = Number(next);

    const [inserted] = await tx
      .insert(importBatches)
      .values({
        runId,
        batchNumber,
        status: "pending",
        recordCountFetched: 0,
      })
      .returning({ id: importBatches.id });

    if (!inserted)
      throw new Error("invariant: failed to insert import_batches row");

    // Move the run to 'fetching' once any batch reservation succeeds so
    // concurrent UI reflects in-progress state immediately.
    if (run.status === "created" || run.status === "reviewing") {
      await tx
        .update(importRuns)
        .set({ status: "fetching" })
        .where(eq(importRuns.id, runId));
    }

    return { batchId: inserted.id, batchNumber, run };
  });
}

/* -------------------------------------------------------------------------- *
 * Scope -> fetch opts *
 * -------------------------------------------------------------------------- */

/** Default root (and child) page size for a fresh run. */
const DEFAULT_ROOT_PAGE_SIZE = 100;

/** Read the per-run root page size from scope, clamped to [1, 100]. */
function readRootPageSize(scopeJson: unknown): number {
  const scope = (scopeJson ?? {}) as RunScope;
  const n = scope.rootPageSize;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1) {
    return Math.min(n, DEFAULT_ROOT_PAGE_SIZE);
  }
  return DEFAULT_ROOT_PAGE_SIZE;
}

function scopeToFetchOpts(
  scopeJson: unknown,
  cursor: string | null,
): BaseFetchOpts {
  const scope = (scopeJson ?? {}) as RunScope;
  // `expand` was removed from BaseFetchOpts — the root-aggregate model
  // never $expands (collection nav names are case-sensitive and the
  // result set is capped and does not page). Children are drained
  // separately via or-chains.
  const opts: BaseFetchOpts = { top: readRootPageSize(scopeJson) };
  if (cursor) {
    opts.nextLink = cursor;
    return opts;
  }
  if (scope.filter?.modifiedSince) {
    const d = new Date(scope.filter.modifiedSince);
    if (!Number.isNaN(d.getTime())) opts.modifiedSince = d;
  }
  if (scope.filter?.ids?.length) {
    opts.ids = scope.filter.ids;
  }
  // Operator-selected statecode restriction ("Active records only"
  // toggle writes statecode=[0]; an explicit empty array means "all
  // states"). Presence of the key is authoritative — pass it through so
  // the query honors the requested scope instead of the per-entity
  // hardcoded default. Absent key → per-entity default applies.
  const statecode = scope.filter?.statecode;
  if (Array.isArray(statecode)) {
    opts.statecode = statecode.filter((c) => Number.isInteger(c));
  }
  return opts;
}

/* -------------------------------------------------------------------------- *
 * Child graph drain + grouping *
 * -------------------------------------------------------------------------- */

/** Every drained child collection for one root page (before grouping). */
interface DrainedChildren {
  task: ChildFetchResult<Record<string, unknown>>;
  phonecall: ChildFetchResult<Record<string, unknown>>;
  appointment: ChildFetchResult<Record<string, unknown>>;
  email: ChildFetchResult<Record<string, unknown>>;
  annotation: ChildFetchResult<Record<string, unknown>>;
}

const EMPTY_CHILD_RESULT: ChildFetchResult<Record<string, unknown>> = {
  records: [],
  truncated: false,
};

/**
 * Drain every child collection regarding `rootIds` for one root type.
 * Activities (task/phonecall/appointment/email) and annotations attach
 * to any of the four root types; annotations additionally filter on the
 * root type's `objecttypecode`.
 *
 * Originated opportunities are NOT drained here — opportunity is a root
 * type imported via its own run; grafting it onto a lead pull was dead
 * (never mapped/committed) and only exposed the truncation halt on data
 * thrown away.
 *
 * Returns immediately with all-empty results when the page yielded no
 * root GUIDs (the helpers short-circuit on an empty id set anyway).
 */
async function drainChildGraph(
  client: D365Client,
  rootType: D365RootType,
  rootIds: string[],
  signal: AbortSignal | undefined,
  pageSize: number,
): Promise<DrainedChildren> {
  if (rootIds.length === 0) {
    return {
      task: EMPTY_CHILD_RESULT,
      phonecall: EMPTY_CHILD_RESULT,
      appointment: EMPTY_CHILD_RESULT,
      email: EMPTY_CHILD_RESULT,
      annotation: EMPTY_CHILD_RESULT,
    };
  }

  // The annotation objecttypecode filter mirrors the root type 1:1
  // (the four root types all carry annotations).
  const annotationRootType = rootType satisfies AnnotationRootType;

  const [task, phonecall, appointment, email, annotation] = await Promise.all([
    fetchTasksForRoots(client, rootIds, { signal, pageSize }),
    fetchPhonecallsForRoots(client, rootIds, { signal, pageSize }),
    fetchAppointmentsForRoots(client, rootIds, { signal, pageSize }),
    fetchEmailsForRoots(client, rootIds, { signal, pageSize }),
    fetchAnnotationsForRoots(client, rootIds, annotationRootType, {
      signal,
      pageSize,
    }),
  ]);

  return {
    task: task as ChildFetchResult<Record<string, unknown>>,
    phonecall: phonecall as ChildFetchResult<Record<string, unknown>>,
    appointment: appointment as ChildFetchResult<Record<string, unknown>>,
    email: email as ChildFetchResult<Record<string, unknown>>,
    annotation: annotation as ChildFetchResult<Record<string, unknown>>,
  };
}

/** Names of every child collection that hit its hard cap (truncated). */
function collectTruncatedKinds(children: DrainedChildren): string[] {
  const kinds: string[] = [];
  if (children.task.truncated) kinds.push("task");
  if (children.phonecall.truncated) kinds.push("phonecall");
  if (children.appointment.truncated) kinds.push("appointment");
  if (children.email.truncated) kinds.push("email");
  if (children.annotation.truncated) kinds.push("annotation");
  return kinds;
}

/** The polymorphic activity → parent reference (GUID of the root). */
const ACTIVITY_PARENT_REF = "_regardingobjectid_value";
/** The note → parent reference. */
const ANNOTATION_PARENT_REF = "_objectid_value";

/**
 * Stitch every drained child to its parent ROOT by raw GUID. Activities
 * group on `_regardingobjectid_value`, annotations on `_objectid_value`.
 * A child whose parent reference is missing or doesn't match a root on
 * this page is dropped from the in-memory map (it will be re-fetched when
 * its true parent root is pulled, or it regards an out-of-scope record) —
 * never silently attached to the wrong root.
 *
 * GUIDs are normalized to lowercase on BOTH sides — the root key is built
 * lowercase (caller passes `rootKeyByLower`) and the child's parent ref is
 * looked up lowercase — so a case-mismatch between the root PK casing and
 * the child's lookup `_value` casing (Dataverse is inconsistent) can never
 * silently drop a child.
 *
 * Returns a map keyed by the LOWERCASE root GUID → the present child
 * arrays for that root. Roots with no children are absent from the map
 * (callers resolve their original-cased GUID via `rootKeyByLower`).
 */
function groupChildrenByParent(
  children: DrainedChildren,
): Map<string, RawChildren> {
  const byRoot = new Map<string, RawChildren>();

  const slotFor = (rootIdLower: string): RawChildren => {
    let slot = byRoot.get(rootIdLower);
    if (!slot) {
      slot = {};
      byRoot.set(rootIdLower, slot);
    }
    return slot;
  };

  const attach = (
    records: Record<string, unknown>[],
    parentRef: string,
    assign: (slot: RawChildren, rec: Record<string, unknown>) => void,
  ): void => {
    for (const rec of records) {
      const parentId = rec[parentRef];
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      assign(slotFor(parentId.toLowerCase()), rec);
    }
  };

  attach(children.task.records, ACTIVITY_PARENT_REF, (slot, rec) => {
    (slot.task ??= []).push(rec);
  });
  attach(children.phonecall.records, ACTIVITY_PARENT_REF, (slot, rec) => {
    (slot.phonecall ??= []).push(rec);
  });
  attach(children.appointment.records, ACTIVITY_PARENT_REF, (slot, rec) => {
    (slot.appointment ??= []).push(rec);
  });
  attach(children.email.records, ACTIVITY_PARENT_REF, (slot, rec) => {
    (slot.email ??= []).push(rec);
  });
  attach(children.annotation.records, ANNOTATION_PARENT_REF, (slot, rec) => {
    (slot.annotation ??= []).push(rec);
  });

  return byRoot;
}

/* -------------------------------------------------------------------------- *
 * Owner-email enrichment *
 * -------------------------------------------------------------------------- */

/**
 * Owner GUIDs per systemuser lookup request. Same Dataverse condition-
 * complexity constraint as the child or-chains — keep it small.
 */
const OWNER_LOOKUP_CHUNK = 30;

/**
 * Stamp each raw record (root OR child) with its owner's Entra UPN under
 * the synthetic `_ownerid_value_email` key so the map-batch owner
 * resolver (`getOwnerEmailFromRaw`) can resolve the real D365 owner
 * instead of always falling back to the default owner.
 *
 * The pull queries only $select the owner GUID (`_ownerid_value`), so
 * the UPN is not present on the wire. We collect the distinct owner
 * GUIDs across the supplied records and resolve them to
 * `systemusers.domainname` (Entra UPN) in a single batched OData lookup.
 *
 * NOTE: the systemuser lookup uses chunked `or`-chains on `systemuserid`.
 * Dataverse rejects the OData `in` operator on EVERY field (501 "The query
 * node In is not supported"), including the systemuserid PK — verified
 * live — so this resolves owners the same way the child fetches do.
 *
 * Mutates the record objects in place. Best-effort: a failed lookup logs
 * and leaves records un-enriched (the resolver then falls back to the
 * default owner for those rows) rather than aborting the pull.
 */
async function enrichOwnerEmails(
  client: D365Client,
  records: Record<string, unknown>[],
  ctx: { runId: string; batchId: string; entityType: D365EntityType },
): Promise<void> {
  if (records.length === 0) return;

  const ownerIds = new Set<string>();
  for (const obj of records) {
    const ownerId = obj["_ownerid_value"];
    if (typeof ownerId === "string" && ownerId.length > 0) {
      ownerIds.add(ownerId);
    }
  }
  if (ownerIds.size === 0) return;

  // GUID -> domainname (UPN). Owners with no domainname (application
  // users, former employees) are omitted; those rows correctly fall back
  // to the default owner downstream. GUIDs are keyed LOWERCASE on both
  // the build and lookup sides — Dataverse is inconsistent about GUID
  // casing across attribute types, and a case mismatch here would miss
  // the lookup and silently fall the record back to the default owner
  // (the exact attribution loss this enrichment exists to prevent).
  const guidToUpn = new Map<string, string>();
  try {
    const ownerList = [...ownerIds];
    for (let i = 0; i < ownerList.length; i += OWNER_LOOKUP_CHUNK) {
      const chunk = ownerList.slice(i, i + OWNER_LOOKUP_CHUNK);
      const orChain = chunk.map((id) => `systemuserid eq ${id}`).join(" or ");
      const page = await client.fetchPage<D365SystemUser>("systemusers", {
        select: ["systemuserid", "domainname"],
        filter: `(${orChain})`,
        top: chunk.length,
        pageSize: chunk.length,
      });
      for (const u of page.value) {
        const upn = u.domainname;
        if (
          u.systemuserid &&
          typeof upn === "string" &&
          upn.trim().length > 0
        ) {
          guidToUpn.set(u.systemuserid.toLowerCase(), upn.trim());
        }
      }
    }
  } catch (err) {
    // Non-fatal: leave records un-enriched and let the owner resolver
    // fall back to the default owner. Surface for the operator trail.
    logger.warn("d365.pull.owner_enrich_failed", {
      runId: ctx.runId,
      batchId: ctx.batchId,
      entityType: ctx.entityType,
      ownerCount: ownerIds.size,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const obj of records) {
    const ownerId = obj["_ownerid_value"];
    if (typeof ownerId === "string") {
      const upn = guidToUpn.get(ownerId.toLowerCase());
      if (upn) obj["_ownerid_value_email"] = upn;
    }
  }
}

/* -------------------------------------------------------------------------- *
 * D365_UNREACHABLE halt path (H-1) *
 * -------------------------------------------------------------------------- */

async function handleFetchFailure(
  runId: string,
  batchId: string,
  actorId: string,
  entityType: D365EntityType,
  err: unknown,
): Promise<never> {
  // Only D365HttpError after retry exhaustion (or a network/abort error)
  // is treated as the H-1 halt; anything else (programmer error) bubbles
  // as an internal error. The retry wrapper has already exhausted
  // backoffs before throwing.
  const isHttp = err instanceof D365HttpError;
  const isUnreachable =
    isHttp ||
    (err instanceof Error &&
      (err.name === "AbortError" ||
        /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(err.message)));

  if (!isUnreachable) {
    // Unknown failure: leave the batch in 'pending' (manual retry) and
    // re-throw so the caller's error boundary surfaces it.
    logger.error("d365.pull.unexpected_error", {
      runId,
      batchId,
      entityType,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // explicit audit event so the forensic trail captures non-halt fetch
    // failures alongside the logger output.
    await writeAudit({
      actorId,
      action: D365_AUDIT_EVENTS.FETCH_FAILED,
      targetType: "import_batch",
      targetId: batchId,
      after: {
        runId,
        entityType,
        errorMessage:
          err instanceof Error
            ? err.message.slice(0, 500)
            : String(err).slice(0, 500),
        kind: "unexpected_error",
      },
    });
    throw err;
  }

  const haltReason = D365_HALT_REASONS.D365_UNREACHABLE;
  // Note shape MUST match the contract read by the run-detail page's
  // parseHaltFromNotes (`kind: "halt"` + `reason: <D365HaltReason>` +
  // optional `message`). Don't change without updating both sides.
  const errorMessage = err instanceof Error ? err.message : String(err);
  const detail = {
    kind: "halt" as const,
    reason: haltReason,
    status: isHttp ? err.status : undefined,
    message: errorMessage,
    errorMessage,
    ts: new Date().toISOString(),
  };

  await persistHalt(runId, batchId, detail);

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.RUN_HALTED,
    targetType: "import_run",
    targetId: runId,
    after: { reason: haltReason, batchId, entityType, detail },
  });

  await broadcastRunEvent(runId, "halted", {
    batchId,
    entityType,
    reason: haltReason,
    detail,
  });

  logger.warn("d365.pull.halted_d365_unreachable", {
    runId,
    batchId,
    entityType,
    status: isHttp ? err.status : undefined,
  });

  throw new D365UnreachableError(
    "Dynamics 365 is unreachable after retries; run paused for review.",
    { runId, batchId, status: isHttp ? err.status : undefined },
  );
}

/* -------------------------------------------------------------------------- *
 * CHILD_COLLECTION_TRUNCATED halt path *
 * -------------------------------------------------------------------------- */

/**
 * Halt the run when a child collection drain hit its hard cap before the
 * collection was exhausted. The drain helper already pages every result;
 * `truncated: true` means the 50k safety cap fired, which signals a
 * pathological parent fan-out, never a normal unfinished page. We refuse
 * to persist a root graph that is missing call history.
 *
 * Self-healing scope shrink: the hard cap is a compile-time constant the
 * operator cannot raise, so a bare `retry` would re-fetch the same dense
 * page and re-truncate forever. Instead we HALVE the per-run root page
 * size in scope (floor 1) and clear the cursor, so the next pull rebuilds
 * the query from scope with a smaller page. Repeated truncations keep
 * halving until each child collection on a page drains under the cap. The
 * reviewer just resumes (retry); the shrink is automatic.
 *
 * Because clearing the cursor re-pulls the run from its first page, we
 * first DELETE this run's not-yet-committed staging rows (`import_records`
 * whose status is not `committed`/`skipped`) so the re-pull doesn't
 * accumulate duplicate staging rows. Committed/skipped records are
 * retained (their CRM rows + reconcile provenance must survive); when
 * their page is re-pulled they dedup idempotently via external_ids. We do
 * NOT delete batch rows — a `committed`/`failed` batch can still hold
 * committed records, so dropping it would orphan their provenance; empty
 * leftover batches are harmless.
 */
async function handleChildTruncation(
  runId: string,
  batchId: string,
  actorId: string,
  entityType: D365EntityType,
  truncatedKinds: string[],
  scopeJson: unknown,
  currentPageSize: number,
): Promise<never> {
  const haltReason = D365_HALT_REASONS.CHILD_COLLECTION_TRUNCATED;
  const nextPageSize = Math.max(1, Math.floor(currentPageSize / 2));
  const message =
    nextPageSize < currentPageSize
      ? `Child collection(s) exceeded the per-batch cap and were not fully drained: ${truncatedKinds.join(", ")}. The page size was reduced from ${currentPageSize} to ${nextPageSize} roots; resume to re-pull the smaller page.`
      : `Child collection(s) exceeded the per-batch cap and were not fully drained: ${truncatedKinds.join(", ")}. The page size is already at the minimum (${currentPageSize}); a single root has more child records than the cap allows — resume to retry.`;
  const detail = {
    kind: "halt" as const,
    reason: haltReason,
    truncatedKinds,
    previousPageSize: currentPageSize,
    nextPageSize,
    message,
    ts: new Date().toISOString(),
  };

  // Shrink the page size, clear the cursor, and drop uncommitted staging
  // rows for this run BEFORE the shared halt write, so the from-scratch
  // re-pull rebuilds with the smaller page and doesn't duplicate staging.
  const shrunkScope: RunScope = {
    ...((scopeJson ?? {}) as RunScope),
    rootPageSize: nextPageSize,
  };
  await db.transaction(async (tx) => {
    // Delete uncommitted staging rows under this run (any batch). Keep
    // `committed`/`skipped` records — their CRM rows + reconcile
    // provenance must survive; the re-pull dedups them via external_ids.
    const runBatchIds = tx
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(eq(importBatches.runId, runId));
    await tx
      .delete(importRecords)
      .where(
        and(
          inArray(importRecords.batchId, runBatchIds),
          inArray(importRecords.status, [
            "pending",
            "mapped",
            "review",
            "approved",
            "rejected",
            "failed",
          ]),
        ),
      );
    await tx
      .update(importRuns)
      .set({
        scope: shrunkScope as unknown as Record<string, unknown>,
        cursor: null,
      })
      .where(eq(importRuns.id, runId));
  });

  await persistHalt(runId, batchId, detail);

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.RUN_HALTED,
    targetType: "import_run",
    targetId: runId,
    after: { reason: haltReason, batchId, entityType, detail },
  });

  await broadcastRunEvent(runId, "halted", {
    batchId,
    entityType,
    reason: haltReason,
    detail,
  });

  logger.warn("d365.pull.halted_child_truncation", {
    runId,
    batchId,
    entityType,
    truncatedKinds,
  });

  throw new D365ChildTruncationError(
    "A child collection was too large to drain in one batch; run paused for review.",
    { runId, batchId, truncatedKinds },
  );
}

/* -------------------------------------------------------------------------- *
 * Shared halt persistence *
 * -------------------------------------------------------------------------- */

/**
 * Flip the batch to `failed` and the run to `paused_for_review`,
 * appending the halt detail to the JSON-line notes stream. We do the
 * string concat in SQL so we don't round-trip the existing notes value
 * to the app server. Shared by both fetch-time halt paths.
 */
async function persistHalt(
  runId: string,
  batchId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const noteLine = `${JSON.stringify(detail)}\n`;
  await db.transaction(async (tx) => {
    await tx
      .update(importBatches)
      .set({ status: "failed" })
      .where(eq(importBatches.id, batchId));

    await tx
      .update(importRuns)
      .set({
        status: "paused_for_review",
        notes: sql`coalesce(${importRuns.notes}, '') || ${noteLine}`,
      })
      .where(eq(importRuns.id, runId));
  });
}

/* -------------------------------------------------------------------------- *
 * Errors *
 * -------------------------------------------------------------------------- */

/**
 * Thrown when the orchestrator transitions a run to `paused_for_review`
 * because Dynamics 365 was unreachable. Caller's server-action
 * `withErrorBoundary` translates this into a CONFLICT-coded ActionResult
 * so the UI can surface a "Resume" CTA.
 */
export class D365UnreachableError extends KnownError {
  constructor(publicMessage: string, meta?: Record<string, unknown>) {
    super("CONFLICT", publicMessage, "d365_unreachable", meta);
    this.name = "D365UnreachableError";
  }
}

/**
 * Thrown when the orchestrator transitions a run to `paused_for_review`
 * because a child collection exceeded the per-batch hard cap and could
 * not be fully drained. CONFLICT-coded so the UI surfaces a "Resume"
 * (retry) CTA — same handling shape as `D365UnreachableError`.
 */
export class D365ChildTruncationError extends KnownError {
  constructor(publicMessage: string, meta?: Record<string, unknown>) {
    super("CONFLICT", publicMessage, "d365_child_truncation", meta);
    this.name = "D365ChildTruncationError";
  }
}
