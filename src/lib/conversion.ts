import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

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
  // True only when a NEW account row was inserted by this conversion;
  // false when an existing account was reused (existingAccountId). Gates
  // the per-entity account.create audit so reuse isn't logged as a create.
  accountCreated: boolean;
}

/**
 * Convert a lead to {Account, Contact, Opportunity} in one transaction.
 *
 * 0. Atomically claim lead status='converted' (conditional UPDATE) —
 *    the concurrency guard; aborts with ConflictError if already
 *    converted or archived, before any INSERT.
 * 1. INSERT or use existing account.
 * 2. INSERT contact, link to account.
 * 3. INSERT opportunity, link to account + primary_contact.
 * 4. Reassign lead's existing activities → opportunity_id (lead_id null).
 * 5. Audit log: lead.convert (emitted after the transaction commits).
 */
export async function convertLead(
  input: ConversionInput,
  actorId: string,
  actorOwnerId: string,
): Promise<ConversionResult> {
  // Pull lead. reject conversion of archived leads. A
  // soft-deleted lead should not be promotable to account/contact/
  // opportunity; the user's archive intent takes precedence.
  const leadRow = await db
    .select()
    .from(leads)
    .where(eq(leads.id, input.leadId))
    .limit(1);
  if (!leadRow[0]) throw new NotFoundError("lead");
  if (leadRow[0].isDeleted) {
    throw new ValidationError(
      "This lead has been archived and cannot be converted. Restore it first.",
    );
  }
  const lead = leadRow[0];

  return db.transaction(async (tx) => {
    // 0. Atomically claim the lead's converted state BEFORE any INSERT.
    // This is the authoritative concurrency guard: the conditional
    // UPDATE only matches when the lead is still active and not yet
    // converted, so two concurrent conversions (double-click, two
    // tabs, two users) cannot both build a full account/contact/
    // opportunity graph — the loser matches zero rows and aborts the
    // transaction before inserting anything. Bumping `version` keeps
    // the lead's OCC counter monotonic so a stale edit form for this
    // lead also fails cleanly afterward. Supavisor-safe atomic
    // conditional UPDATE (no session lock).
    const claimed = await tx
      .update(leads)
      .set({
        status: "converted",
        convertedAt: sql`now()`,
        updatedById: actorId,
        updatedAt: sql`now()`,
        version: sql`${leads.version} + 1`,
      })
      .where(
        and(
          eq(leads.id, input.leadId),
          eq(leads.isDeleted, false),
          ne(leads.status, "converted"),
        ),
      )
      .returning({ id: leads.id });
    if (claimed.length !== 1) {
      throw new ConflictError(
        "This lead has already been converted. Open the linked account to continue.",
      );
    }

    // 1. Account.
    let accountId: string;
    let accountCreated = false;
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
      accountCreated = true;
    } else {
      throw new ValidationError(
        "Must specify existingAccountId or newAccount.",
      );
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

    // 4. (Lead already marked converted by the atomic claim in step 0.)

    // 5. Reassign lead's activities → opportunity (if created), else
    // leave them on the lead. The CHECK constraint requires
    // exactly-one-parent, so we set lead_id NULL when setting
    // opportunity_id.
    if (opportunityId) {
      await tx
        .update(activities)
        .set({ leadId: null, opportunityId })
        .where(eq(activities.leadId, input.leadId));
    }

    return { accountId, contactId, opportunityId, accountCreated };
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
  // Per-entity create audit so converted records are individually
  // attributable. Only entities actually created here are emitted —
  // a reused existing account, or a skipped contact/opportunity, is
  // excluded.
  const createEvents: Parameters<typeof writeAuditBatch>[0]["events"] = [];
  if (result.accountCreated) {
    createEvents.push({
      action: "account.create",
      targetType: "account",
      targetId: result.accountId,
      after: { via: "lead_convert", leadId: input.leadId },
    });
  }
  if (result.contactId) {
    createEvents.push({
      action: "contact.create",
      targetType: "contact",
      targetId: result.contactId,
      after: { via: "lead_convert", leadId: input.leadId },
    });
  }
  if (result.opportunityId) {
    createEvents.push({
      action: "opportunity.create",
      targetType: "opportunity",
      targetId: result.opportunityId,
      after: { via: "lead_convert", leadId: input.leadId },
    });
  }
  await writeAuditBatch({ actorId, events: createEvents });
  return result;
}
