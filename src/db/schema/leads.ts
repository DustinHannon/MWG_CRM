import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  leadCreationMethodEnum,
  leadRatingEnum,
  leadSourceEnum,
  leadStatusEnum,
} from "./enums";
import { importJobs } from "./imports";
import { users } from "./users";

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // ON DELETE RESTRICT: deleting a user with owned leads must go
    // through the admin "delete user" flow which forces a reassign or a
    // cascade-delete decision. Phase 1 used SET NULL which silently
    // orphaned leads — corrected in the phase2_integrity_owner_restrict
    // migration.
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    status: leadStatusEnum("status").notNull().default("new"),
    rating: leadRatingEnum("rating").notNull().default("warm"),
    source: leadSourceEnum("source").notNull().default("other"),
    salutation: text("salutation"),
    firstName: text("first_name").notNull(),
    // Phase 6A — last_name nullable. Real CRM data routinely has incomplete
    // name records (e.g., "Amy", "Mr.", "Unknown"). The leads_last_name_len
    // CHECK still validates length when non-NULL.
    lastName: text("last_name"),
    jobTitle: text("job_title"),
    companyName: text("company_name"),
    industry: text("industry"),
    email: text("email"),
    phone: text("phone"),
    mobilePhone: text("mobile_phone"),
    website: text("website"),
    linkedinUrl: text("linkedin_url"),
    street1: text("street1"),
    street2: text("street2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    estimatedValue: numeric("estimated_value", { precision: 14, scale: 2 }),
    estimatedCloseDate: date("estimated_close_date"),
    description: text("description"),
    // Phase 6A — Subject line ("Topic" in legacy D365 dumps). Stored
    // separately from description so it can be searched and indexed
    // independently. CHECK constraint caps at 1000 chars (intentional —
    // some D365 Topic values are essentially the customer's full inbound
    // message). Indexed via leads_subject_trgm_idx and the FTS index.
    subject: text("subject"),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    doNotEmail: boolean("do_not_email").notNull().default(false),
    doNotCall: boolean("do_not_call").notNull().default(false),
    tags: text("tags").array(),
    externalId: text("external_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    // How this lead was created. Defaults to manual; the import handler
    // sets this to 'imported' alongside import_job_id.
    createdVia: leadCreationMethodEnum("created_via").notNull().default("manual"),
    importJobId: uuid("import_job_id").references(() => importJobs.id, {
      onDelete: "set null",
    }),
    createdById: uuid("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    // Optimistic concurrency stamp. Bumped by every UPDATE through
    // concurrentUpdate(); a stale `version` causes ConflictError.
    version: integer("version").notNull().default(1),
    // Phase 4G — soft delete. activeLeads() filters by `is_deleted = false`.
    // Cron `/api/cron/purge-archived` hard-deletes after 30 days.
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedById: uuid("deleted_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deleteReason: text("delete_reason"),
    // Phase 4C — lead scoring (rules-based).
    score: integer("score").notNull().default(0),
    scoreBand: text("score_band").notNull().default("cold"),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
  },
  (t) => [
    index("leads_owner_idx").on(t.ownerId),
    index("leads_status_idx").on(t.status),
    index("leads_email_idx").on(t.email),
    index("leads_company_idx").on(t.companyName),
    index("leads_external_id_idx").on(t.externalId),
    index("leads_last_activity_idx").on(t.lastActivityAt.desc()),
    // GIN index on tags array for membership filters.
    index("leads_tags_gin_idx").using("gin", t.tags),
    // Partial index — only useful when querying by import.
    index("leads_import_job_idx")
      .on(t.importJobId)
      .where(sql`import_job_id IS NOT NULL`),
  ],
);
