import { eq } from "drizzle-orm";
import { leads } from "@/db/schema/leads";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";

/**
 * Phase 4G — soft-delete helpers. Default queries on these entities should
 * filter out archived rows. Importing these helpers as filter fragments makes
 * it harder to forget. `notDeleted(table)` returns the equality fragment;
 * `activeX` returns the table reference for parity with future helpers.
 */

export const notDeletedLead = () => eq(leads.isDeleted, false);
export const notDeletedAccount = () => eq(crmAccounts.isDeleted, false);
export const notDeletedContact = () => eq(contacts.isDeleted, false);
export const notDeletedOpportunity = () => eq(opportunities.isDeleted, false);
export const notDeletedTask = () => eq(tasks.isDeleted, false);
