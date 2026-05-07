import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  leadRatingEnum,
  leadSourceEnum,
  leadStatusEnum,
} from "./enums";
import { users } from "./users";

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: leadStatusEnum("status").notNull().default("new"),
    rating: leadRatingEnum("rating").notNull().default("warm"),
    source: leadSourceEnum("source").notNull().default("other"),
    salutation: text("salutation"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
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
    doNotContact: boolean("do_not_contact").notNull().default(false),
    doNotEmail: boolean("do_not_email").notNull().default(false),
    doNotCall: boolean("do_not_call").notNull().default(false),
    tags: text("tags").array(),
    externalId: text("external_id"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
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
  ],
);
