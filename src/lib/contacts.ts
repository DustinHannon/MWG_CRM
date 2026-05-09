import "server-only";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { expectAffected } from "@/lib/db/concurrent-update";
import { nameField } from "@/lib/validation/primitives";

/**
 * Phase 9C (workflow) — direct Contact creation from `/contacts/new`,
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

/** Phase 10 — soft-delete contacts. */
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(contacts.id, ids));
}

/** Phase 10 — restore archived contacts. */
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
      // Phase 12 — actor stamping for skip-self in Supabase Realtime.
      updatedById: actorId,
      updatedAt: sql`now()`,
    })
    .where(inArray(contacts.id, ids));
}

/** Phase 10 — admin hard-delete. */
export async function deleteContactsById(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(contacts).where(inArray(contacts.id, ids));
}

/**
 * Phase 13 — paginated contact listing for /api/v1/contacts.
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
