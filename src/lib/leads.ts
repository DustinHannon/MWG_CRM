import "server-only";
import { logger } from "@/lib/logger";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";
import { tasks } from "@/db/schema/tasks";
import { leadTags, tags as tagsTable } from "@/db/schema/tags";
import { users } from "@/db/schema/users";
import { cascadeMarker, cascadeMarkerSql } from "@/lib/cascade-archive";
import { expectAffected } from "@/lib/db/concurrent-update";
import type { SessionUser } from "@/lib/auth-helpers";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import {
  nameField,
  optionalEmailField,
  optionalMoneyField,
  optionalUrlField,
} from "@/lib/validation/primitives";

export { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES };

/**
 * The filters arrive from URL query strings (and from saved-view JSON).
 * URL forms always serialise empty <select> values as `key=` — an empty
 * string. zod's z.enum REJECTS empty strings (they're not in the enum),
 * which is the root cause of the "Apply button throws" bug.
 *
 * Fix: pre-process the raw input via `sanitizeFilterInput` below so empty
 * strings collapse to undefined BEFORE the schema parse. This applies to
 * the URL submit path (the Apply button) and to any future programmatic
 * caller, so the schema itself stays strict.
 */
const emptyToUndef = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), s);

const leadFiltersSchema = z.object({
  q: emptyToUndef(z.string().trim().max(200)).optional(),
  status: emptyToUndef(z.enum(LEAD_STATUSES)).optional(),
  rating: emptyToUndef(z.enum(LEAD_RATINGS)).optional(),
  source: emptyToUndef(z.enum(LEAD_SOURCES)).optional(),
  ownerId: emptyToUndef(z.string().uuid()).optional(),
  tag: emptyToUndef(z.string().trim().max(80)).optional(),
  page: emptyToUndef(z.coerce.number().int().min(1)).default(1),
  pageSize: emptyToUndef(z.coerce.number().int().min(10).max(200)).default(50),
  sort: emptyToUndef(
    z.enum(["lastActivity", "created", "name", "company", "value"]),
  ).default("lastActivity"),
  dir: emptyToUndef(z.enum(["asc", "desc"])).default("desc"),
});

/**
 * cursor codec. Pagination cursors are stable strings of the
 * form `<iso8601>:<uuid>`. The leading timestamp is whichever column
 * drives the active sort (last_activity_at, updated_at, etc.); the
 * trailing uuid is the row's id, used as a tiebreaker so cursor seeks
 * stay deterministic across rows that share a timestamp.
 *
 * NULL timestamps are encoded as the literal string "null" so the
 * `(updated_at, id) < (cursorTs, cursorId)` semantics translate to
 * the SQL-level NULLS LAST ordering used by every list view.
 */
export interface ParsedCursor {
  ts: Date | null;
  id: string;
}

export function parseCursor(raw: string | undefined | null): ParsedCursor | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return null;
  const tsPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  // basic uuid sanity (avoids letting users inject arbitrary text into
  // the where clause; the parameterised binding in `sql` handles the
  // rest, but parse-time validation lets us drop bad cursors silently).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idPart)) {
    return null;
  }
  if (tsPart === "null" || tsPart === "") return { ts: null, id: idPart };
  const d = new Date(tsPart);
  if (Number.isNaN(d.getTime())) return null;
  return { ts: d, id: idPart };
}

export function encodeCursor(ts: Date | null, id: string): string {
  return `${ts ? ts.toISOString() : "null"}:${id}`;
}

export type LeadFilters = z.infer<typeof leadFiltersSchema>;

/**
 * Belt + suspenders: reject any payload where do_not_contact=true but
 * do_not_email=false or do_not_call=false. The lead-form UX auto-checks
 * + disables those when DNC is on, but a forged form / API caller could
 * skip that — this refinement closes that gap server-side.
 */
const leadCreateSchemaBase = z.object({
  salutation: z.string().max(20).optional().nullable(),
  firstName: nameField,
  // last_name is now nullable. Manual create form still
  // marks the field required via HTML/UI, but the schema accepts empty
  // so the import path can carry NULL through.
  lastName: nameField.or(z.literal("")).optional().nullable(),
  jobTitle: z.string().max(200).optional().nullable(),
  companyName: z.string().max(200).optional().nullable(),
  industry: z.string().max(100).optional().nullable(),
  email: optionalEmailField,
  phone: z.string().max(40).optional().nullable(),
  mobilePhone: z.string().max(40).optional().nullable(),
  website: optionalUrlField,
  linkedinUrl: optionalUrlField,
  street1: z.string().max(200).optional().nullable(),
  street2: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  description: z.string().max(20_000).optional().nullable(),
  // leads.subject (the "Topic:" line in legacy D365 dumps).
  subject: z.string().max(1000).optional().nullable(),
  status: z.enum(LEAD_STATUSES).default("new"),
  rating: z.enum(LEAD_RATINGS).default("warm"),
  source: z.enum(LEAD_SOURCES).default("other"),
  estimatedValue: optionalMoneyField,
  estimatedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  doNotContact: z.boolean().default(false),
  doNotEmail: z.boolean().default(false),
  doNotCall: z.boolean().default(false),
  // `tags` removed from lead create/update schema. Tags are
  // managed via the relational lead_tags table; the lead-form's free-text
  // tags input is silently ignored (will be replaced with a tag picker
  // in a follow-up). Schema is permissive — extra keys are stripped.
  //
  // `ownerId` is intentionally NOT a field here. Ownership is a privileged
  // attribution column and drives the entire non-admin visibility / edit /
  // delete model. Letting the user-facing create/update forms carry it was
  // a mass-assignment vector (a non-admin could steal or hide leads by
  // forging an `ownerId` form field). Trusted server-side callers — the
  // API-key REST path and imports — set the owner explicitly via the
  // `ownerId` option on createLead / updateLead, never through `input`.
});

const dncRefinement = (data: {
  doNotContact?: boolean;
  doNotEmail?: boolean;
  doNotCall?: boolean;
}) => {
  if (!data.doNotContact) return true;
  return data.doNotEmail !== false && data.doNotCall !== false;
};

export const leadCreateSchema = leadCreateSchemaBase.refine(dncRefinement, {
  message:
    "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
  path: ["doNotContact"],
});

/**
 * Partial-update schema. Built off the unrefined base because z.refine()
 * turns a ZodObject into ZodEffects, which doesn't have .partial(). Re-
 * apply the DNC refinement after .partial().
 */
const leadUpdateSchema = leadCreateSchemaBase
  .partial()
  .extend({ id: z.string().uuid() })
  .refine(dncRefinement, {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  });

/** For server-action callers that need a partial without the id field. */
export const leadPartialSchema = leadCreateSchemaBase.partial().refine(
  dncRefinement,
  {
    message:
      "Do Not Contact implies Do Not Email and Do Not Call — both must be true.",
    path: ["doNotContact"],
  },
);

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

export interface LeadListResult {
  rows: Array<{
    id: string;
    salutation: string | null;
    firstName: string;
    lastName: string | null;
    jobTitle: string | null;
    companyName: string | null;
    industry: string | null;
    email: string | null;
    phone: string | null;
    mobilePhone: string | null;
    website: string | null;
    linkedinUrl: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    description: string | null;
    subject: string | null;
    status: (typeof LEAD_STATUSES)[number];
    rating: (typeof LEAD_RATINGS)[number];
    source: (typeof LEAD_SOURCES)[number];
    doNotContact: boolean;
    doNotEmail: boolean;
    doNotCall: boolean;
    ownerId: string | null;
    ownerDisplayName: string | null;
    estimatedValue: string | null;
    estimatedCloseDate: string | null;
    convertedAt: Date | null;
    lastActivityAt: Date | null;
    externalId: string | null;
    score: number;
    scoreBand: string;
    createdVia: string;
    version: number;
    updatedAt: Date;
    createdAt: Date;
    tags: string[] | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

export async function listLeads(
  user: SessionUser,
  rawFilters: unknown,
  canViewAll: boolean,
): Promise<LeadListResult> {
  // safeParse + log on failure: an unknown filter shape should NOT throw
  // and crash the page. Bad filters produce an empty result set + warning.
  const parsed = leadFiltersSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    logger.warn("leads.invalid_filters", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }
  const filters = parsed.success
    ? parsed.data
    : leadFiltersSchema.parse({});

  const wheres = [];
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    wheres.push(
      or(
        ilike(leads.firstName, pattern),
        ilike(leads.lastName, pattern),
        ilike(leads.email, pattern),
        ilike(leads.companyName, pattern),
        ilike(leads.phone, pattern),
      ),
    );
  }
  if (filters.status) wheres.push(eq(leads.status, filters.status));
  if (filters.rating) wheres.push(eq(leads.rating, filters.rating));
  if (filters.source) wheres.push(eq(leads.source, filters.source));
  if (filters.ownerId) wheres.push(eq(leads.ownerId, filters.ownerId));
  if (filters.tag) {
    // legacy `leads.tags` column was dropped. Membership now
    // resolves via the relational lead_tags table joined to tags.name.
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM ${leadTags} lt
        JOIN ${tagsTable} t ON t.id = lt.tag_id
        WHERE lt.lead_id = ${leads.id} AND lower(t.name) = lower(${filters.tag})
      )`,
    );
  }
  // Non-admin without canViewAllRecords sees only their own.
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }

  // default queries hide archived rows.
  wheres.push(eq(leads.isDeleted, false));

  const whereExpr = wheres.length > 0 ? and(...wheres) : undefined;

  const sortColumn = (() => {
    switch (filters.sort) {
      case "name":
        return leads.lastName;
      case "company":
        return leads.companyName;
      case "value":
        return leads.estimatedValue;
      case "created":
        return leads.createdAt;
      default:
        return leads.lastActivityAt;
    }
  })();
  const order = filters.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

  // Offset pagination only. The migrated UI uses runView() in views.ts
  // which has its own cursor path; listLeads is only reached from the
  // export route (?page=1, pageSize=10_000) and the public REST API
  // (/api/v1/leads, ?page=N).
  const offset = (filters.page - 1) * filters.pageSize;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        salutation: leads.salutation,
        firstName: leads.firstName,
        lastName: leads.lastName,
        jobTitle: leads.jobTitle,
        companyName: leads.companyName,
        industry: leads.industry,
        email: leads.email,
        phone: leads.phone,
        mobilePhone: leads.mobilePhone,
        website: leads.website,
        linkedinUrl: leads.linkedinUrl,
        street1: leads.street1,
        street2: leads.street2,
        city: leads.city,
        state: leads.state,
        postalCode: leads.postalCode,
        country: leads.country,
        description: leads.description,
        subject: leads.subject,
        status: leads.status,
        rating: leads.rating,
        source: leads.source,
        doNotContact: leads.doNotContact,
        doNotEmail: leads.doNotEmail,
        doNotCall: leads.doNotCall,
        ownerId: leads.ownerId,
        ownerDisplayName: users.displayName,
        estimatedValue: leads.estimatedValue,
        estimatedCloseDate: leads.estimatedCloseDate,
        convertedAt: leads.convertedAt,
        lastActivityAt: leads.lastActivityAt,
        externalId: leads.externalId,
        score: leads.score,
        scoreBand: leads.scoreBand,
        createdVia: leads.createdVia,
        version: leads.version,
        updatedAt: leads.updatedAt,
        createdAt: leads.createdAt,
        // hydrate tag names from the relational lead_tags
        // join. Returns NULL when the lead has no tags so existing UI
        // null-checks keep working.
        tags: sql<string[] | null>`(
          SELECT array_agg(t.name ORDER BY t.name)
          FROM ${leadTags} lt
          JOIN ${tagsTable} t ON t.id = lt.tag_id
          WHERE lt.lead_id = ${leads.id}
        )`,
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(whereExpr)
      .orderBy(order, desc(leads.id))
      .limit(filters.pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(whereExpr),
  ]);

  return {
    rows: rowsRaw,
    total: totalRow[0]?.count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function getLeadById(
  user: SessionUser,
  id: string,
  canViewAll: boolean,
) {
  const wheres = [eq(leads.id, id)];
  if (!user.isAdmin && !canViewAll) {
    wheres.push(eq(leads.ownerId, user.id));
  }
  const row = await db
    .select()
    .from(leads)
    .where(and(...wheres))
    .limit(1);
  if (!row[0]) return null;
  // hydrate tag names from the relational lead_tags table.
  // The legacy `leads.tags text[]` column was dropped; consumers still
  // expect `lead.tags: string[] | null` so we fetch and attach.
  const tagRows = await db
    .select({ name: tagsTable.name })
    .from(leadTags)
    .innerJoin(tagsTable, eq(tagsTable.id, leadTags.tagId))
    .where(eq(leadTags.leadId, row[0].id))
    .orderBy(asc(tagsTable.name));
  const tagNames = tagRows.map((t) => t.name);
  return { ...row[0], tags: tagNames.length > 0 ? tagNames : null };
}

export async function createLead(
  user: SessionUser,
  input: LeadCreateInput,
  // Owner assignment is a privileged, server-side-only channel — it is NOT
  // part of the validated `input` (the user-facing form schema cannot carry
  // it). Only trusted callers (the API-key REST path, imports) pass it.
  opts?: { ownerId?: string | null },
): Promise<{ id: string }> {
  const ownerId = opts?.ownerId ?? user.id;
  const inserted = await db
    .insert(leads)
    .values({
      ownerId,
      status: input.status,
      rating: input.rating,
      source: input.source,
      salutation: input.salutation ?? null,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      jobTitle: input.jobTitle ?? null,
      companyName: input.companyName ?? null,
      industry: input.industry ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      website: input.website ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
      subject: input.subject ?? null,
      doNotContact: input.doNotContact,
      doNotEmail: input.doNotEmail,
      doNotCall: input.doNotCall,
      estimatedValue: input.estimatedValue,
      estimatedCloseDate: input.estimatedCloseDate ?? null,
      createdById: user.id,
      updatedById: user.id,
      // `last_activity_at` left NULL on creation so scoring
      // recency rules don't treat just-imported / just-created leads as
      // engaged. It bumps when the first counting activity (note / call /
      // email / meeting / task) is logged.
    })
    .returning({ id: leads.id });
  return { id: inserted[0].id };
}

/**
 * OCC backend wiring. Update path is now version-checked:
 * the caller passes the `expectedVersion` it loaded with the row, the
 * UPDATE only fires when the on-disk version still matches, and we
 * bump version + updated_at in the same statement.
 *
 * Throws ConflictError when another writer moved the row between the
 * caller's read and this update; throws NotFoundError when the id is
 * gone. Both carry user-facing public messages.
 */
/**
 * Columns that must never be set via the generic `input` spread in
 * updateLead. Identity, ownership, OCC, audit, and soft-delete columns all
 * have dedicated, gated write paths; ownership in particular is the
 * privileged channel (see `opts.ownerId` below). This is the structural
 * guard against mass-assignment: even if one of these keys ever leaks into
 * a validated input object, the spread skips it.
 */
const PROTECTED_LEAD_UPDATE_KEYS = new Set<string>([
  "id",
  "ownerId",
  "createdById",
  "updatedById",
  "createdAt",
  "updatedAt",
  "version",
  "isDeleted",
  "deletedAt",
  "deletedById",
]);

export async function updateLead(
  user: SessionUser,
  id: string,
  expectedVersion: number,
  input: Partial<LeadCreateInput>,
  // Owner reassignment is a privileged, server-side-only channel (see
  // createLead). The generic `input` spread below CANNOT set ownership —
  // ownerId is only written when a trusted caller passes it here.
  opts?: { ownerId?: string | null },
): Promise<{ id: string; version: number }> {
  const update: Record<string, unknown> = {
    updatedById: user.id,
    updatedAt: sql`now()`,
    version: sql`${leads.version} + 1`,
  };
  for (const key of Object.keys(input) as Array<keyof LeadCreateInput>) {
    // Never mass-assign identity / ownership / OCC / soft-delete columns
    // from a generic input object — they have dedicated, gated write paths.
    if (PROTECTED_LEAD_UPDATE_KEYS.has(key as string)) continue;
    update[key] = input[key];
  }
  if (opts && "ownerId" in opts) {
    update.ownerId = opts.ownerId ?? null;
  }
  // 046 — `is_deleted = false` clause prevents a stale
  // edit form from silently overwriting a row that was archived between
  // load and submit. With this filter the UPDATE matches zero rows,
  // expectAffected throws NotFoundError, and the user sees the correct
  // public message instead of a phantom success.
  const rows = await db
    .update(leads)
    .set(update)
    .where(
      and(
        eq(leads.id, id),
        eq(leads.version, expectedVersion),
        eq(leads.isDeleted, false),
      ),
    )
    .returning({ id: leads.id, version: leads.version });
  await expectAffected(rows, { table: leads, id, entityLabel: "lead" });
  return rows[0];
}

/**
 * Hard-delete a batch of lead ids. Cascades through activities, tasks,
 * lead_tags, attachments. Use only from admin flows or the purge cron;
 * regular users archive via `archiveLeadsById()`.
 *
 * @actor admin or purge cron only
 */
export async function deleteLeadsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(leads).where(inArray(leads.id, ids));
}

/** Result of a cascade soft-delete / restore: child rows affected. */
export interface CascadeArchiveResult {
  cascadedTasks: number;
  cascadedActivities: number;
}

/**
 * Single-lead archive result. `flipped` reports whether the parent row's
 * `isDeleted` actually transitioned false→true on THIS call (the UPDATE
 * filters `isDeleted=false`, so a concurrent double-submit only flips the
 * row once). The interactive caller short-circuits its audit / notification
 * / activity / undo side effects when `flipped` is false so a losing
 * double-submit doesn't emit a duplicate forensic row.
 */
export interface LeadArchiveResult extends CascadeArchiveResult {
  flipped: boolean;
}

/**
 * Cascade-archive a batch of leads and their dependent children.
 *
 * `string[]` signature: every caller archives by id without a client
 * `version`. This single-record path (`softDeleteLeadAction`, public
 * `/api/v1` delete, restore-undo) is the ONLY archive path for leads —
 * the leads list has no bulk-archive selection surface, so there is no
 * per-row-OCC bulk variant here (unlike accounts'
 * `bulkArchiveAccounts`). If a leads bulk-archive surface is ever
 * added, mirror the accounts OCC pattern (action + per-row `{id,
 * version}` + conflict toast); do not reuse this id-only path for it.
 *
 * Soft-delete is a plain UPDATE so the DB `ON DELETE CASCADE` never
 * fires; we replicate it in one transaction (STANDARDS 19.1.1 — the
 * parent and its children must flip atomically; a partially-cascaded
 * archive must never be observable). Only currently-active children are
 * touched, and each carries the cascade sentinel in `delete_reason` so
 * `restore` can reactivate exactly the rows this cascade archived
 * (children the user archived independently keep their own reason and
 * stay archived).
 *
 * @actor lead owner or admin
 */
export async function archiveLeadsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<LeadArchiveResult> {
  if (ids.length === 0) {
    return { flipped: false, cascadedTasks: 0, cascadedActivities: 0 };
  }
  return db.transaction(async (tx) => {
    const flippedRows = await tx
      .update(leads)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: reason ?? null,
        // actor stamping for skip-self in Supabase Realtime.
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      // Guard isDeleted=false so a re-archive is a no-op on the parent
      // row rather than clobbering the original soft-delete attribution
      // (parity with archiveContactsById and the accounts path).
      // `.returning()` reports which rows actually transitioned so a
      // concurrent double-submit (both reads pass, only one UPDATE flips)
      // can short-circuit its duplicate audit / notification side effects.
      .where(and(inArray(leads.id, ids), eq(leads.isDeleted, false)))
      .returning({ id: leads.id });
    const cascade = await cascadeArchiveLeadChildren(tx, ids, actorId);
    return { flipped: flippedRows.length > 0, ...cascade };
  });
}

/**
 * Soft-delete the active tasks/activities of the given leads, marking
 * each with the cascade sentinel so restore is selective. Runs inside
 * the caller's transaction. Set-based (one UPDATE per child table) so
 * the bulk path stays O(1) round-trips regardless of id count.
 */
async function cascadeArchiveLeadChildren(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  leadIds: string[],
  actorId: string,
): Promise<CascadeArchiveResult> {
  const cascadedTasks = await tx
    .update(tasks)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: cascadeMarkerSql("lead", tasks.leadId),
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(and(inArray(tasks.leadId, leadIds), eq(tasks.isDeleted, false)))
    .returning({ id: tasks.id });
  const cascadedActivities = await tx
    .update(activities)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorId,
      deleteReason: cascadeMarkerSql("lead", activities.leadId),
      // activities has no updated_by_id (skip-self keys off user_id);
      // do not alter user_id so authorship attribution is preserved.
      updatedAt: sql`now()`,
    })
    .where(
      and(inArray(activities.leadId, leadIds), eq(activities.isDeleted, false)),
    )
    .returning({ id: activities.id });
  return {
    cascadedTasks: cascadedTasks.length,
    cascadedActivities: cascadedActivities.length,
  };
}

/**
 * Restore archived leads and the children THIS lead's archive cascaded
 * (matched by the exact `delete_reason` sentinel — independently
 * archived children are intentionally left archived). One transaction.
 *
 * @actor admin only
 */
export async function restoreLeadsById(
  ids: string[],
  actorId: string,
): Promise<CascadeArchiveResult> {
  if (ids.length === 0) return { cascadedTasks: 0, cascadedActivities: 0 };
  return db.transaction(async (tx) => {
    await tx
      .update(leads)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        updatedAt: sql`now()`,
        updatedById: actorId,
        // OCC bump on restore mirrors archive + update; without it,
        // a concurrent edit-from-stale-version after restore would
        // silently win.
        version: sql`${leads.version} + 1`,
      })
      .where(inArray(leads.id, ids));
    let cascadedTasks = 0;
    let cascadedActivities = 0;
    // Cascaded children skip the OCC version bump (symmetric with
    // archive); updateTask/updateActivity filter is_deleted=false
    // so stale-version edits on restored children fail with
    // NotFoundError, not silent wins.
    for (const id of ids) {
      const t = await tx
        .update(tasks)
        .set({
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
          deleteReason: null,
          updatedById: actorId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(tasks.leadId, id),
            eq(tasks.isDeleted, true),
            eq(tasks.deleteReason, cascadeMarker("lead", id)),
          ),
        )
        .returning({ id: tasks.id });
      const a = await tx
        .update(activities)
        .set({
          isDeleted: false,
          deletedAt: null,
          deletedById: null,
          deleteReason: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(activities.leadId, id),
            eq(activities.isDeleted, true),
            eq(activities.deleteReason, cascadeMarker("lead", id)),
          ),
        )
        .returning({ id: activities.id });
      cascadedTasks += t.length;
      cascadedActivities += a.length;
    }
    return { cascadedTasks, cascadedActivities };
  });
}

// ---------------------------------------------------------------------------
// Archived (soft-deleted) leads — cursor-paginated list for the admin
// archive page. Sort is fixed `(deleted_at DESC, id DESC)`; admin-only
// scoping is enforced at the route layer.
// ---------------------------------------------------------------------------

export interface ArchivedLeadCursorRow {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  deletedAt: Date | null;
  reason: string | null;
  deletedById: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
}

export async function listArchivedLeadsCursor(args: {
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ArchivedLeadCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const baseWhere = eq(leads.isDeleted, true);
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) {
      return sql`(${leads.deletedAt} IS NULL AND ${leads.id} < ${parsedCursor.id})`;
    }
    return sql`(
      ${leads.deletedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${leads.deletedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${leads.id} < ${parsedCursor.id})
      OR ${leads.deletedAt} IS NULL
    )`;
  })();
  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        companyName: leads.companyName,
        deletedAt: leads.deletedAt,
        reason: leads.deleteReason,
        deletedById: leads.deletedById,
        deletedByEmail: users.email,
        deletedByName: users.displayName,
      })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.deletedById))
      .where(finalWhere)
      .orderBy(sql`${leads.deletedAt} DESC NULLS LAST`, desc(leads.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(baseWhere),
  ]);

  let data = rowsRaw;
  let nextCursor: string | null = null;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.deletedAt, last.id, "desc");
  }
  return { data, nextCursor, total: totalRow[0]?.count ?? 0 };
}
