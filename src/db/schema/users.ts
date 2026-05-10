import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Application users. Three populations live here:
 *  - Entra (SSO) users: provisioned on first successful sign-in.
 *  - Breakglass user (singleton, is_breakglass=true): seeded once on first
 *    server boot. Always available even if Entra/SSO is broken.
 *
 * `is_admin` is independent of `permissions` — admins bypass every per-feature
 * permission flag. Bumping `session_version` invalidates outstanding JWTs.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entraOid: text("entra_oid"),
    username: text("username").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    displayName: text("display_name").notNull(),
    photoBlobUrl: text("photo_blob_url"),
    photoSyncedAt: timestamp("photo_synced_at", { withTimezone: true }),
    isBreakglass: boolean("is_breakglass").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    passwordHash: text("password_hash"),
    sessionVersion: integer("session_version").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastSentItemsSyncAt: timestamp("last_sent_items_sync_at", {
      withTimezone: true,
    }),
    lastCalendarSyncAt: timestamp("last_calendar_sync_at", {
      withTimezone: true,
    }),
    // Phase 3B: Entra-sourced profile fields. Read-only on /settings.
    // Refreshed on every Entra sign-in. Never used in lead workflow.
    jobTitle: text("job_title"),
    department: text("department"),
    officeLocation: text("office_location"),
    businessPhones: text("business_phones")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mobilePhone: text("mobile_phone"),
    country: text("country"),
    managerEntraOid: text("manager_entra_oid"),
    managerDisplayName: text("manager_display_name"),
    managerEmail: text("manager_email"),
    entraSyncedAt: timestamp("entra_synced_at", { withTimezone: true }),
    // Phase 15 — Mailbox capability (cached). 'exchange_online' | 'on_premises'
    // | 'unknown' | 'not_licensed'. Re-checked at most every 24h, on every
    // sign-in, or on-demand via admin "Re-check mailbox".
    mailboxKind: text("mailbox_kind"),
    mailboxCheckedAt: timestamp("mailbox_checked_at", { withTimezone: true }),
    jitProvisioned: boolean("jit_provisioned").notNull().default(false),
    jitProvisionedAt: timestamp("jit_provisioned_at", { withTimezone: true }),
    firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("users_username_uniq").on(t.username),
    uniqueIndex("users_email_uniq").on(t.email),
    uniqueIndex("users_entra_oid_uniq")
      .on(t.entraOid)
      .where(sql`entra_oid IS NOT NULL`),
    // CRITICAL: enforces that at most one breakglass user can exist.
    // Combined with `INSERT ... WHERE NOT EXISTS` makes seeding race-safe.
    uniqueIndex("users_one_breakglass")
      .on(t.isBreakglass)
      .where(sql`is_breakglass = true`),
  ],
);

/**
 * Per-user feature flags. Admin bypasses these (see auth helpers).
 *
 * Phase 3G renamed `can_view_all_leads` → `can_view_all_records` since
 * the flag now governs leads + crm_accounts + contacts + opportunities.
 */
export const permissions = pgTable("permissions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  canViewAllRecords: boolean("can_view_all_records").notNull().default(false),
  canCreateLeads: boolean("can_create_leads").notNull().default(true),
  canEditLeads: boolean("can_edit_leads").notNull().default(true),
  canDeleteLeads: boolean("can_delete_leads").notNull().default(false),
  canImport: boolean("can_import").notNull().default(false),
  canExport: boolean("can_export").notNull().default(false),
  canSendEmail: boolean("can_send_email").notNull().default(true),
  canViewReports: boolean("can_view_reports").notNull().default(true),
  // Phase 5E — grants visibility into records owned by the user's
  // direct reports (per Microsoft Entra `manager` field). Independent
  // of canViewAllRecords; manager users can flip this without unlocking
  // org-wide visibility. Access-gate wiring + entity-level UI surfaces
  // are tracked in ROADMAP — schema landed first so the column is
  // available for future work.
  canViewTeamRecords: boolean("can_view_team_records").notNull().default(false),
  // Phase 19 — gates the Marketing tab (templates, lists, campaigns,
  // suppressions). Admin bypasses. Defaults to false; flip per user via
  // /admin/users/<id>/permissions.
  canManageMarketing: boolean("can_manage_marketing").notNull().default(false),
});

// =============================================================================
// Auth.js (next-auth v5) Drizzle adapter tables
// Schema mirrors @auth/drizzle-adapter's expectations. Keep field names exact.
// We persist Microsoft Graph access_token / refresh_token / expires_at on
// `accounts` so server-side Graph fetches can run without re-auth.
// =============================================================================

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({
      columns: [t.provider, t.providerAccountId],
      name: "accounts_pkey",
    }),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.identifier, t.token],
      name: "verification_tokens_pkey",
    }),
  ],
);
