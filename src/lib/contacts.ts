import "server-only";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, crmAccounts } from "@/db/schema/crm-records";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
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

/** soft-delete contacts. */
export async function archiveContactsById(
  ids: string[],
  actorId: string,
  reason?: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
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
}

/** restore archived contacts. */
export async function restoreContactsById(
  ids: string[],
  actorId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
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

/**
 * Filter shape for the canonical cursor-paginated contact list. Sort
 * is fixed `(updated_at DESC, id DESC)` so the query stays on the
 * partial index `contacts_updated_at_id_idx`.
 */
export interface ContactCursorFilters {
  q?: string;
  accountId?: string;
  ownerId?: string;
}

export interface ContactCursorRow {
  id: string;
  firstName: string;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  accountId: string | null;
  accountName: string | null;
  ownerId: string | null;
  ownerDisplayName: string | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Canonical cursor-paginated contact list. Sort fixed
 * `(updated_at DESC, id DESC)`. Returns `{ data, nextCursor, total }`.
 *
 * Permission scoping mirrors `listContactsForApi`: non-admin without
 * `canViewAllRecords` sees only their own.
 */
export async function listContactsCursor(args: {
  actorId: string;
  isAdmin: boolean;
  canViewAll: boolean;
  filters: ContactCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: ContactCursorRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 50;
  const { actorId, isAdmin, canViewAll, filters } = args;

  const wheres = [eq(contacts.isDeleted, false)];
  if (filters.q) {
    const pat = `%${filters.q}%`;
    wheres.push(
      or(
        ilike(contacts.firstName, pat),
        ilike(contacts.lastName, pat),
        ilike(contacts.email, pat),
      )!,
    );
  }
  if (filters.accountId) wheres.push(eq(contacts.accountId, filters.accountId));
  if (filters.ownerId) wheres.push(eq(contacts.ownerId, filters.ownerId));
  if (!isAdmin && !canViewAll) {
    wheres.push(eq(contacts.ownerId, actorId));
  }
  const baseWhere = and(...wheres);

  // updated_at is NOT NULL on contacts.
  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = parsedCursor && parsedCursor.ts
    ? sql`(
        ${contacts.updatedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
        OR (${contacts.updatedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${contacts.id} < ${parsedCursor.id})
      )`
    : undefined;

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        jobTitle: contacts.jobTitle,
        email: contacts.email,
        phone: contacts.phone,
        mobilePhone: contacts.mobilePhone,
        accountId: contacts.accountId,
        accountName: crmAccounts.name,
        ownerId: contacts.ownerId,
        ownerDisplayName: users.displayName,
        updatedAt: contacts.updatedAt,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .leftJoin(crmAccounts, eq(contacts.accountId, crmAccounts.id))
      .leftJoin(users, eq(contacts.ownerId, users.id))
      .where(finalWhere)
      .orderBy(desc(contacts.updatedAt), desc(contacts.id))
      .limit(pageSize + 1),
    db.select({ n: count() }).from(contacts).where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.updatedAt, last.id, "desc");
  }

  return {
    data,
    nextCursor,
    total: totalRow[0]?.n ?? 0,
  };
}
