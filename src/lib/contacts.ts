import "server-only";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { cascadeMarker, cascadeMarkerSql } from "@/lib/cascade-archive";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";
import { expectAffected } from "@/lib/db/concurrent-update";
import { nameField } from "@/lib/validation/primitives";

/**
 * direct Contact creation from `/contacts/new`,
 * separate from the lead-conversion path (`src/lib/conversion.ts`).
 * Optional `accountId` lets the form prefill from `?accountId=X` so
 * the "New contact" button on Account detail flows naturally.
 *
 * Schema mirrors the conversion path's contact insert: required first
 * name, optional last name (nullable in schema), free-form contact
 * fields. DNC stays off by default — users can flip it from edit.
 */
export const contactCreateSchema = z.object({
  accountId: z.string().uuid().optional().nullable(),
  firstName: nameField,
  lastName: nameField.or(z.literal("")).optional().nullable(),
  jobTitle: z.string().trim().max(200).optional().nullable(),
  email: z
    .string()
    .trim()
    .email("Not a valid email")
    .max(254)
    .or(z.literal(""))
    .optional()
    .nullable(),
  phone: z.string().trim().max(60).optional().nullable(),
  mobilePhone: z.string().trim().max(60).optional().nullable(),
  description: z.string().trim().max(20_000).optional().nullable(),
  // Address
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(80).optional().nullable(),
  // Birthdate stored as YYYY-MM-DD; accept ISO timestamp prefix too.
  birthdate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}/u, "Use YYYY-MM-DD")
    .max(10)
    .or(z.literal(""))
    .optional()
    .nullable(),
  // Preferences
  doNotEmail: z.coerce.boolean().optional(),
  doNotCall: z.coerce.boolean().optional(),
  doNotMail: z.coerce.boolean().optional(),
});

export type ContactCreateInput = z.infer<typeof contactCreateSchema>;

export async function createContact(
  input: ContactCreateInput,
  actorId: string,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(contacts)
    .values({
      accountId: input.accountId || null,
      firstName: input.firstName,
      lastName: input.lastName ? input.lastName : null,
      jobTitle: input.jobTitle ?? null,
      email: input.email ? input.email : null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      description: input.description ?? null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      birthdate: input.birthdate ? input.birthdate.slice(0, 10) : null,
      doNotEmail: input.doNotEmail ?? false,
      doNotCall: input.doNotCall ?? false,
      doNotMail: input.doNotMail ?? false,
      doNotContact: (input.doNotEmail ?? false) && (input.doNotCall ?? false),
      ownerId: actorId,
      createdById: actorId,
    })
    .returning({ id: contacts.id });

  await writeAudit({
    actorId,
    action: "contact.create",
    targetType: "contacts",
    targetId: inserted[0].id,
    after: {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      accountId: input.accountId ?? null,
    },
  });

  return { id: inserted[0].id };
}

/** Cascade soft-delete / restore counts for a contact. */
export interface ContactCascadeResult {
  cascadedTasks: number;
  cascadedActivities: number;
}

/**
 * Cascade-archive contacts and their dependent tasks/activities in one
 * transaction (STANDARDS 19.1.1). Soft-delete is a plain UPDATE so the
 * DB cascade never fires; cascaded children carry the contact-scoped
 * sentinel `__cascade__:contact:<id>` so restore is selective.
 *
 * (Account-driven cascades use the account-scoped sentinel instead, so
 * a contact archived as part of an account closure is restored with
 * that account — not independently — which is correct.)
 *
 * @actor contact owner or admin (caller enforces)
 */
export async function archiveContactsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<ContactCascadeResult> {
  if (ids.length === 0) return { cascadedTasks: 0, cascadedActivities: 0 };
  return db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: reason ?? null,
        // actor stamping for skip-self in Supabase Realtime.
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(inArray(contacts.id, ids));
    const cascadedTasks = await tx
      .update(tasks)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("contact", tasks.contactId),
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(and(inArray(tasks.contactId, ids), eq(tasks.isDeleted, false)))
      .returning({ id: tasks.id });
    const cascadedActivities = await tx
      .update(activities)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("contact", activities.contactId),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(activities.contactId, ids),
          eq(activities.isDeleted, false),
        ),
      )
      .returning({ id: activities.id });
    return {
      cascadedTasks: cascadedTasks.length,
      cascadedActivities: cascadedActivities.length,
    };
  });
}

/** Per-row optimistic-concurrency input for bulk contact archive. */
export interface ContactArchiveRow {
  id: string;
  version: number;
}

/**
 * Bulk archive contacts with per-row optimistic concurrency. A row is
 * archived only when its on-disk `version` still matches the version
 * the client loaded; rows another writer moved are returned in
 * `conflicts` untouched (no silent lost update — closes the asymmetry
 * where single-row contact edits enforced OCC but bulk archive did
 * not). The whole batch (contact flips + child tasks/activities
 * cascade) runs in one transaction (STANDARDS 19.1.1).
 *
 * Mirrors `bulkArchiveAccounts`: the caller filters to permitted rows
 * first, then this enforces OCC and cascades the contact-scoped
 * sentinel so restore stays selective.
 *
 * @actor contact owner or admin (caller enforces per-record permission)
 */
export async function bulkArchiveContacts(
  rows: ContactArchiveRow[],
  actorId: string,
  reason?: string,
): Promise<
  { updated: string[]; conflicts: string[] } & ContactCascadeResult
> {
  if (rows.length === 0) {
    return {
      updated: [],
      conflicts: [],
      cascadedTasks: 0,
      cascadedActivities: 0,
    };
  }
  return db.transaction(async (tx) => {
    const updated: string[] = [];
    const conflicts: string[] = [];
    for (const row of rows) {
      const claimed = await tx
        .update(contacts)
        .set({
          isDeleted: true,
          deletedAt: sql`now()`,
          deletedById: actorId,
          deleteReason: reason ?? null,
          updatedById: actorId,
          updatedAt: sql`now()`,
          version: sql`${contacts.version} + 1`,
        })
        .where(
          and(
            eq(contacts.id, row.id),
            eq(contacts.version, row.version),
            eq(contacts.isDeleted, false),
          ),
        )
        .returning({ id: contacts.id });
      if (claimed.length === 1) {
        updated.push(row.id);
        continue;
      }
      // 0 rows: distinguish a stale version (conflict) from an
      // already-archived no-op (idempotent skip). Probe the live row
      // in-transaction — consistent with the bulk task OCC fns
      // (STANDARDS 1.8 sibling parity).
      const [live] = await tx
        .select({ version: contacts.version })
        .from(contacts)
        .where(eq(contacts.id, row.id))
        .limit(1);
      if (live && live.version !== row.version) conflicts.push(row.id);
      // else: already archived at the same version — idempotent no-op.
    }
    if (updated.length === 0) {
      return { updated, conflicts, cascadedTasks: 0, cascadedActivities: 0 };
    }
    const cascadedTasks = await tx
      .update(tasks)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("contact", tasks.contactId),
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(
        and(inArray(tasks.contactId, updated), eq(tasks.isDeleted, false)),
      )
      .returning({ id: tasks.id });
    const cascadedActivities = await tx
      .update(activities)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorId,
        deleteReason: cascadeMarkerSql("contact", activities.contactId),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(activities.contactId, updated),
          eq(activities.isDeleted, false),
        ),
      )
      .returning({ id: activities.id });
    return {
      updated,
      conflicts,
      cascadedTasks: cascadedTasks.length,
      cascadedActivities: cascadedActivities.length,
    };
  });
}

/**
 * Restore archived contacts and exactly the tasks/activities THIS
 * contact's archive cascaded (contact-scoped sentinel match). One
 * transaction.
 *
 * @actor admin only (caller enforces)
 */
export async function restoreContactsById(
  ids: string[],
  actorId: string,
): Promise<ContactCascadeResult> {
  if (ids.length === 0) return { cascadedTasks: 0, cascadedActivities: 0 };
  return db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        // actor stamping for skip-self in Supabase Realtime.
        updatedById: actorId,
        updatedAt: sql`now()`,
      })
      .where(inArray(contacts.id, ids));
    let cascadedTasks = 0;
    let cascadedActivities = 0;
    for (const id of ids) {
      const marker = cascadeMarker("contact", id);
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
            eq(tasks.contactId, id),
            eq(tasks.isDeleted, true),
            eq(tasks.deleteReason, marker),
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
            eq(activities.contactId, id),
            eq(activities.isDeleted, true),
            eq(activities.deleteReason, marker),
          ),
        )
        .returning({ id: activities.id });
      cascadedTasks += t.length;
      cascadedActivities += a.length;
    }
    return { cascadedTasks, cascadedActivities };
  });
}

/** admin hard-delete. */
export async function deleteContactsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(contacts).where(inArray(contacts.id, ids));
}

/**
 * paginated contact listing for /api/v1/contacts.
 */
export async function listContactsForApi(args: {
  q?: string;
  accountId?: string;
  ownerId?: string;
  page: number;
  pageSize: number;
  ownerScope: { actorId: string; canViewAll: boolean };
}): Promise<{
  rows: Array<typeof contacts.$inferSelect>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const wheres = [eq(contacts.isDeleted, false)];
  if (args.q) {
    const pat = `%${args.q}%`;
    wheres.push(
      or(
        ilike(contacts.firstName, pat),
        ilike(contacts.lastName, pat),
        ilike(contacts.email, pat),
      )!,
    );
  }
  if (args.accountId) wheres.push(eq(contacts.accountId, args.accountId));
  if (args.ownerId) wheres.push(eq(contacts.ownerId, args.ownerId));
  if (!args.ownerScope.canViewAll) {
    wheres.push(eq(contacts.ownerId, args.ownerScope.actorId));
  }
  const where = and(...wheres);
  const offset = (args.page - 1) * args.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.updatedAt), desc(contacts.id))
      .limit(args.pageSize)
      .offset(offset),
    db.select({ n: count() }).from(contacts).where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    page: args.page,
    pageSize: args.pageSize,
  };
}

export async function getContactForApi(
  id: string,
  ownerScope: { actorId: string; canViewAll: boolean },
): Promise<typeof contacts.$inferSelect | null> {
  const wheres = [eq(contacts.id, id), eq(contacts.isDeleted, false)];
  if (!ownerScope.canViewAll) {
    wheres.push(eq(contacts.ownerId, ownerScope.actorId));
  }
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(...wheres))
    .limit(1);
  return row ?? null;
}

export async function updateContactForApi(
  id: string,
  patch: Partial<{
    accountId: string | null;
    firstName: string;
    lastName: string | null;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    mobilePhone: string | null;
    description: string | null;
    // Phase-31 D365 parity additions.
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    birthdate: string | null;
    doNotEmail: boolean;
    doNotCall: boolean;
    doNotMail: boolean;
    doNotContact: boolean;
  }>,
  expectedVersion: number | undefined,
  actorId: string,
): Promise<{ id: string; version: number }> {
  const set: Record<string, unknown> = {
    ...patch,
    updatedById: actorId,
    updatedAt: sql`now()`,
    version: sql`${contacts.version} + 1`,
  };
  const wheres = [eq(contacts.id, id), eq(contacts.isDeleted, false)];
  if (typeof expectedVersion === "number") {
    wheres.push(eq(contacts.version, expectedVersion));
  }
  const rows = await db
    .update(contacts)
    .set(set)
    .where(and(...wheres))
    .returning({ id: contacts.id, version: contacts.version });
  expectAffected(rows, { table: contacts, id, entityLabel: "contact" });
  return rows[0];
}


// ---------------------------------------------------------------------------
// Archived (soft-deleted) contacts — cursor-paginated list for the admin
// archive page. Sort fixed `(deleted_at DESC, id DESC)`.
// ---------------------------------------------------------------------------

export interface ArchivedContactCursorRow {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  deletedAt: Date | null;
  reason: string | null;
  deletedById: string | null;
  deletedByEmail: string | null;
  deletedByName: string | null;
}

export async function listArchivedContactsCursor(args: {
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ArchivedContactCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const baseWhere = eq(contacts.isDeleted, true);
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) {
      return sql`(${contacts.deletedAt} IS NULL AND ${contacts.id} < ${parsedCursor.id})`;
    }
    return sql`(
      ${contacts.deletedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${contacts.deletedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${contacts.id} < ${parsedCursor.id})
      OR ${contacts.deletedAt} IS NULL
    )`;
  })();
  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        deletedAt: contacts.deletedAt,
        reason: contacts.deleteReason,
        deletedById: contacts.deletedById,
        deletedByEmail: users.email,
        deletedByName: users.displayName,
      })
      .from(contacts)
      .leftJoin(users, eq(users.id, contacts.deletedById))
      .where(finalWhere)
      .orderBy(sql`${contacts.deletedAt} DESC NULLS LAST`, desc(contacts.id))
      .limit(pageSize + 1),
    db.select({ n: count() }).from(contacts).where(baseWhere),
  ]);

  let data = rowsRaw;
  let nextCursor: string | null = null;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.deletedAt, last.id, "desc");
  }
  return { data, nextCursor, total: totalRow[0]?.n ?? 0 };
}
