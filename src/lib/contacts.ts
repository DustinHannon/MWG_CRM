import "server-only";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
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
