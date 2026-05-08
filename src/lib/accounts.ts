import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { writeAudit } from "@/lib/audit";
import { urlField } from "@/lib/validation/primitives";

/**
 * Phase 9C (workflow) — direct Account creation from `/accounts/new`,
 * separate from the lead-conversion path. The conversion path lives in
 * `src/lib/conversion.ts` and stays single-transaction; this is the
 * stand-alone "I already know who this customer is" entry point.
 *
 * Schema mirrors the columns the convert flow populates (name + a small
 * core of optional fields). Address fields are accepted but optional —
 * the form keeps the create surface small; users edit details from the
 * account detail page after the fact.
 */
export const accountCreateSchema = z.object({
  name: z.string().trim().min(1, "Required").max(200),
  industry: z.string().trim().max(100).optional().nullable(),
  website: urlField.or(z.literal("")).optional().nullable(),
  phone: z.string().trim().max(60).optional().nullable(),
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().max(20_000).optional().nullable(),
});

export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/**
 * Insert a new account. Owner defaults to the actor when not supplied.
 * Audit row written best-effort by the calling server action via
 * `writeAudit` so the function stays usable from import / batch flows.
 */
export async function createAccount(
  input: AccountCreateInput,
  actorId: string,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(crmAccounts)
    .values({
      name: input.name,
      industry: input.industry ?? null,
      website: input.website ? input.website : null,
      phone: input.phone ?? null,
      street1: input.street1 ?? null,
      street2: input.street2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      description: input.description ?? null,
      ownerId: actorId,
      createdById: actorId,
    })
    .returning({ id: crmAccounts.id });

  await writeAudit({
    actorId,
    action: "account.create",
    targetType: "crm_accounts",
    targetId: inserted[0].id,
    after: { name: input.name },
  });

  return { id: inserted[0].id };
}

/**
 * Phase 9C (workflow) — pickable account list for the New Contact /
 * New Opportunity forms. Returns up to 500 accounts visible to the
 * caller, sorted alphabetically. The brief calls out autocomplete as
 * a future polish; today we render a plain `<select>` and 500 is
 * comfortable for that. Owner-scope mirrors the listing pages.
 */
export async function listAccountsForPicker(
  actorId: string,
  canViewAll: boolean,
): Promise<Array<{ id: string; name: string }>> {
  const wheres = [eq(crmAccounts.isDeleted, false)];
  if (!canViewAll) wheres.push(eq(crmAccounts.ownerId, actorId));
  const rows = await db
    .select({ id: crmAccounts.id, name: crmAccounts.name })
    .from(crmAccounts)
    .where(and(...wheres))
    .orderBy(asc(crmAccounts.name))
    .limit(500);
  return rows;
}
