import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user saved view of the leads table — filters + columns + sort.
 *
 * `scope` controls owner-side filtering: 'mine' restricts to the user's
 * own leads; 'all' requires the user to be admin or have
 * canViewAllRecords. The lead-list query enforces this at fetch time, not
 * here, so any view stored as 'all' is just a UI hint.
 *
 * `filters` shape: { status?: string[]; rating?: string[]; source?: string[];
 * tags?: string[]; search?: string; do_not_contact?: boolean }
 * `columns` shape: string[] of column keys (see lib/views.ts AVAILABLE_COLUMNS)
 * `sort` shape: { field: string; direction: 'asc' | 'desc' }
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // `entity_type` scopes views by domain. 'lead'
    // (default) preserves prior behaviour; 'task' powers the new
    // /tasks page saved-view selector. CHECK constraint
    // `saved_views_entity_type_valid` restricts to known values.
    entityType: text("entity_type").notNull().default("lead"),
    name: text("name").notNull(),
    isPinned: boolean("is_pinned").notNull().default(false),
    scope: text("scope").notNull().default("mine"),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    columns: jsonb("columns").notNull().default(sql`'[]'::jsonb`),
    sort: jsonb("sort")
      .notNull()
      .default(sql`'{"field":"last_activity_at","direction":"desc"}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("saved_views_user_idx").on(t.userId),
    index("saved_views_user_entity_idx").on(t.userId, t.entityType),
    unique("saved_views_user_entity_name_uniq").on(
      t.userId,
      t.entityType,
      t.name,
    ),
  ],
);

/**
 * Per-user UI preferences — theme, default landing page, last view, and
 * any ad-hoc column choices made while a built-in view is active.
 *
 * Auto-created on user provisioning. Backfilled in migration
 * 20260507_phase2_features_views_prefs_creation_method.
 */
export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("system"),
  defaultLandingPage: text("default_landing_page").notNull().default("/dashboard"),
  lastUsedViewId: uuid("last_used_view_id").references(() => savedViews.id, {
    onDelete: "set null",
  }),
  // last-used view on /tasks. text not uuid because
  // built-in views use string ids ("builtin:my-open") that don't
  // match the savedViews uuid FK shape.
  lastUsedTaskViewId: text("last_used_task_view_id"),
  // ad-hoc column visibility chosen on a built-in view (saved views
  // store their own columns array on the saved_views row instead).
  adhocColumns: jsonb("adhoc_columns"),
  // editable preferences surfaced on /settings.
  timezone: text("timezone").notNull().default("America/Chicago"),
  dateFormat: text("date_format").notNull().default("MM/DD/YYYY"),
  timeFormat: text("time_format").notNull().default("12h"),
  tableDensity: text("table_density").notNull().default("comfortable"),
  // sidebar collapsed/expanded state.
  sidebarCollapsed: boolean("sidebar_collapsed").notNull().default(false),
  defaultLeadsViewId: uuid("default_leads_view_id").references(
    () => savedViews.id,
    { onDelete: "set null" },
  ),
  customLandingPath: text("custom_landing_path"),
  notifyTasksDue: boolean("notify_tasks_due").notNull().default(true),
  notifyTasksAssigned: boolean("notify_tasks_assigned").notNull().default(true),
  notifyMentions: boolean("notify_mentions").notNull().default(true),
  notifySavedSearch: boolean("notify_saved_search").notNull().default(true),
  emailDigestFrequency: text("email_digest_frequency").notNull().default("off"),
  // pipeline/table view-mode preference.
  leadsDefaultMode: text("leads_default_mode").notNull().default("table"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  version: integer("version").notNull().default(1),
});
