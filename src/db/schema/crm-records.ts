import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { leads } from "./leads";
import { users } from "./users";

/**
 * CRM record entities (post-conversion). Lead conversion
 * creates Account → Contact → Opportunity in a single transaction.
 *
 * NOTE: the SQL table is `crm_accounts` to avoid a collision with the
 * Auth.js `accounts` table. UI labels say "Accounts".
 */
export const crmAccounts = pgTable(
  "crm_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    industry: text("industry"),
    website: text("website"),
    phone: text("phone"),
    email: text("email"),
    accountNumber: text("account_number"),
    numberOfEmployees: integer("number_of_employees"),
    annualRevenue: numeric("annual_revenue", { precision: 18, scale: 2 }),
    street1: text("street1"),
    street2: text("street2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    description: text("description"),
    d365StateCode: integer("d365_state_code"),
    d365StatusCode: integer("d365_status_code"),
    // FK enforced at the DB level; Drizzle treats these as plain uuid
    // columns to avoid the circular-reference dance between
    // crm_accounts and contacts.
    parentAccountId: uuid("parent_account_id"),
    primaryContactId: uuid("primary_contact_id"),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // actor stamp for realtime skip-self. Set on every UPDATE
    // by callers via concurrentUpdate or explicit .set({ updatedById }).
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceLeadId: uuid("source_lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    // D365 custom-field passthrough.
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("crm_accounts_owner_idx").on(t.ownerId),
    index("crm_accounts_name_idx").on(sql`lower(${t.name})`),
    // composite cursor pagination key for /accounts list.
    index("crm_accounts_updated_at_id_idx")
      .on(t.updatedAt.desc(), t.id.desc())
      .where(sql`is_deleted = false`),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountId: uuid("account_id").references(() => crmAccounts.id, {
      onDelete: "set null",
    }),
    firstName: text("first_name").notNull(),
    // last_name nullable on contacts to mirror leads. The
    // contacts_last_len CHECK still validates length when non-NULL.
    lastName: text("last_name"),
    jobTitle: text("job_title"),
    email: text("email"),
    phone: text("phone"),
    mobilePhone: text("mobile_phone"),
    description: text("description"),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    doNotEmail: boolean("do_not_email").notNull().default(false),
    doNotCall: boolean("do_not_call").notNull().default(false),
    doNotMail: boolean("do_not_mail").notNull().default(false),
    // D365 contact address1_* and birthdate.
    street1: text("street1"),
    street2: text("street2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    birthdate: date("birthdate"),
    // D365 state + status codes preserved verbatim. statecode=1
    // (Inactive) is mirrored as is_deleted=true at import time.
    d365StateCode: integer("d365_state_code"),
    d365StatusCode: integer("d365_status_code"),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // actor stamp for realtime skip-self. Set on every UPDATE
    // by callers via concurrentUpdate or explicit .set({ updatedById }).
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceLeadId: uuid("source_lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    // D365 custom-field passthrough.
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("contacts_account_idx").on(t.accountId),
    index("contacts_owner_idx").on(t.ownerId),
    index("contacts_email_idx").on(sql`lower(${t.email})`),
    // composite cursor pagination key for /contacts list.
    index("contacts_updated_at_id_idx")
      .on(t.updatedAt.desc(), t.id.desc())
      .where(sql`is_deleted = false`),
    // city filter (lowercase-folded) for future "contacts in X" filters.
    index("contacts_city_idx")
      .on(sql`lower(${t.city})`)
      .where(sql`is_deleted = false`),
  ],
);

export const opportunityStageEnum = pgEnum("opportunity_stage", [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
]);

export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // accountId is nullable so imports can create lead-only
    // opportunities. When a lead is later converted, accountId gets set.
    accountId: uuid("account_id").references(() => crmAccounts.id, {
      onDelete: "cascade",
    }),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    stage: opportunityStageEnum("stage").notNull().default("prospecting"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    probability: integer("probability"),
    expectedCloseDate: date("expected_close_date"),
    description: text("description"),
    d365StateCode: integer("d365_state_code"),
    d365StatusCode: integer("d365_status_code"),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // actor stamp for realtime skip-self. Set on every UPDATE
    // by callers via concurrentUpdate or explicit .set({ updatedById }).
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceLeadId: uuid("source_lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    // D365 custom-field passthrough.
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("opportunities_account_idx").on(t.accountId),
    index("opportunities_owner_idx").on(t.ownerId),
    index("opportunities_stage_idx").on(t.stage),
    // composite cursor pagination keys. The list page sorts
    // by expected_close_date NULLS LAST (default) but server-side
    // updated_at sort fallbacks also exist. Partial on is_deleted=false.
    index("opportunities_close_date_id_idx")
      .on(sql`expected_close_date DESC NULLS LAST`, t.id.desc())
      .where(sql`is_deleted = false`),
    index("opportunities_updated_at_id_idx")
      .on(t.updatedAt.desc(), t.id.desc())
      .where(sql`is_deleted = false`),
  ],
);
