import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";

export const conversionSchema = z.object({
  leadId: z.string().uuid(),
  // Account: either an existing id, or new account fields.
  existingAccountId: z.string().uuid().optional().nullable(),
  newAccount: z
    .object({
      name: z.string().trim().min(1).max(200),
      industry: z.string().trim().max(100).optional().nullable(),
      website: z.string().trim().max(500).optional().nullable(),
      phone: z.string().trim().max(60).optional().nullable(),
    })
    .optional()
    .nullable(),
  // Contact (optional — user may convert just to an account+opportunity).
  newContact: z
    .object({
      firstName: z.string().trim().min(1).max(120),
      lastName: z.string().trim().min(1).max(120),
      jobTitle: z.string().trim().max(200).optional().nullable(),
      email: z.string().trim().max(320).optional().nullable(),
      phone: z.string().trim().max(60).optional().nullable(),
      mobilePhone: z.string().trim().max(60).optional().nullable(),
    })
    .optional()
    .nullable(),
  // Opportunity (optional).
  newOpportunity: z
    .object({
      name: z.string().trim().min(1).max(200),
      amount: z.coerce.number().nullable().optional(),
      expectedCloseDate: z.string().optional().nullable(),
      description: z.string().trim().max(2000).optional().nullable(),
    })
    .optional()
    .nullable(),
});

export type ConversionInput = z.infer<typeof conversionSchema>;

export interface ConversionResult {
  accountId: string;
  contactId: string | null;
  opportunityId: string | null;
}

/**
 * Convert a lead to {Account, Contact, Opportunity} in one transaction.
 *
 * 1. INSERT or use existing account.
 * 2. INSERT contact, link to account.
 * 3. INSERT opportunity, link to account + primary_contact.
 * 4. UPDATE lead → status='converted', converted_at=now().
 * 5. Reassign lead's existing activities → opportunity_id (lead_id null).
 * 6. Audit log: lead.convert.
 */
export async function convertLead(
  input: ConversionInput,
  actorId: string,
  actorOwnerId: string,
): Promise<ConversionResult> {
  // Pull lead.
  const leadRow = await db
    .select()
    .from(leads)
    .where(eq(leads.id, input.leadId))
    .limit(1);
  if (!leadRow[0]) throw new Error("Lead not found");
  const lead = leadRow[0];

  return db.transaction(async (tx) => {
    // 1. Account.
    let accountId: string;
    if (input.existingAccountId) {
      accountId = input.existingAccountId;
    } else if (input.newAccount) {
      const inserted = await tx
        .insert(crmAccounts)
        .values({
          name: input.newAccount.name,
          industry: input.newAccount.industry ?? lead.industry ?? null,
          website: input.newAccount.website ?? lead.website ?? null,
          phone: input.newAccount.phone ?? lead.phone ?? null,
          street1: lead.street1,
          street2: lead.street2,
          city: lead.city,
          state: lead.state,
          postalCode: lead.postalCode,
          country: lead.country,
          ownerId: actorOwnerId,
          createdById: actorId,
          sourceLeadId: lead.id,
        })
        .returning({ id: crmAccounts.id });
      accountId = inserted[0].id;
    } else {
      throw new Error("Must specify existingAccountId or newAccount.");
    }

    // 2. Contact (optional).
    let contactId: string | null = null;
    if (input.newContact) {
      const inserted = await tx
        .insert(contacts)
        .values({
          accountId,
          firstName: input.newContact.firstName,
          lastName: input.newContact.lastName,
          jobTitle: input.newContact.jobTitle ?? lead.jobTitle ?? null,
          email: input.newContact.email ?? lead.email ?? null,
          phone: input.newContact.phone ?? lead.phone ?? null,
          mobilePhone: input.newContact.mobilePhone ?? lead.mobilePhone ?? null,
          doNotContact: lead.doNotContact,
          doNotEmail: lead.doNotEmail,
          doNotCall: lead.doNotCall,
          ownerId: actorOwnerId,
          createdById: actorId,
          sourceLeadId: lead.id,
        })
        .returning({ id: contacts.id });
      contactId = inserted[0].id;
    }

    // 3. Opportunity (optional).
    let opportunityId: string | null = null;
    if (input.newOpportunity) {
      const inserted = await tx
        .insert(opportunities)
        .values({
          accountId,
          primaryContactId: contactId,
          name: input.newOpportunity.name,
          stage: "prospecting",
          amount:
            input.newOpportunity.amount != null
              ? String(input.newOpportunity.amount)
              : lead.estimatedValue,
          expectedCloseDate:
            input.newOpportunity.expectedCloseDate ?? lead.estimatedCloseDate,
          description:
            input.newOpportunity.description ?? lead.description ?? null,
          ownerId: actorOwnerId,
          createdById: actorId,
          sourceLeadId: lead.id,
        })
        .returning({ id: opportunities.id });
      opportunityId = inserted[0].id;
    }

    // 4. Mark lead converted.
    await tx
      .update(leads)
      .set({
        status: "converted",
        convertedAt: sql`now()`,
        updatedById: actorId,
      })
      .where(eq(leads.id, input.leadId));

    // 5. Reassign lead's activities → opportunity (if created), else
    //    leave them on the lead. The CHECK constraint requires
    //    exactly-one-parent, so we set lead_id NULL when setting
    //    opportunity_id.
    if (opportunityId) {
      await tx
        .update(activities)
        .set({ leadId: null, opportunityId })
        .where(eq(activities.leadId, input.leadId));
    }

    return { accountId, contactId, opportunityId };
  });
}

/**
 * Server-action helper: combines convertLead with audit. Pass results
 * back to the caller for redirect.
 */
export async function convertLeadWithAudit(
  input: ConversionInput,
  actorId: string,
  actorOwnerId: string,
): Promise<ConversionResult> {
  const result = await convertLead(input, actorId, actorOwnerId);
  await writeAudit({
    actorId,
    action: "lead.convert",
    targetType: "leads",
    targetId: input.leadId,
    after: {
      accountId: result.accountId,
      contactId: result.contactId,
      opportunityId: result.opportunityId,
    },
  });
  return result;
}
