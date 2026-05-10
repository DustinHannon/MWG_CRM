import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Phase 19 — Marketing email templates.
 *
 * Designed inside the embedded Unlayer editor (react-email-editor 1.8.0)
 * and stored here both as the raw Unlayer JSON design (`unlayer_design_json`)
 * and the exported HTML (`rendered_html`). On save we additionally push the
 * HTML to SendGrid as a Dynamic Template version and capture the returned
 * ids on `sendgrid_template_id` / `sendgrid_version_id` so the marketing
 * send path uses SendGrid Dynamic Templates instead of inline HTML payloads
 * — that way the template-design history lives with us, but the per-send
 * personalization (dynamic_template_data) flows through SendGrid as
 * intended.
 *
 * Soft-delete is on (is_deleted/deleted_at) — templates are referenced from
 * campaigns and we never want to FK-cascade history away. Hard-delete is
 * reserved for an admin "purge" tool that also archives in SendGrid.
 *
 * The version column is an OCC stamp bumped on every UPDATE; concurrent
 * editors collaborate via the `template_locks` soft-lock below, but the
 * version stamp catches the rare case where the lock was force-released.
 */
export const marketingTemplates = pgTable(
  "marketing_templates",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    description: text("description"),
    subject: text("subject").notNull(),
    preheader: text("preheader"),
    /**
     * Raw JSON returned by `editor.exportHtml({ design })`. The shape is
     * Unlayer-private and changes between editor versions, so we treat it
     * as opaque blob and never query inside it. On load we hand it back to
     * `editor.loadDesign(design)` verbatim.
     */
    unlayerDesignJson: jsonb("unlayer_design_json").notNull(),
    renderedHtml: text("rendered_html").notNull(),
    /** SendGrid Dynamic Template id (e.g. `d-<uuid>`). Null until first save. */
    sendgridTemplateId: text("sendgrid_template_id"),
    /** Active SendGrid template version id. Null until first save. */
    sendgridVersionId: text("sendgrid_version_id"),
    status: text("status", {
      enum: ["draft", "ready", "archived"],
    })
      .notNull()
      .default("draft"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedById: uuid("updated_by_id").references(() => users.id, {
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
  },
  (t) => [
    index("mkt_tpl_status_idx").on(t.status),
    index("mkt_tpl_deleted_idx")
      .on(t.deletedAt)
      .where(sql`is_deleted = true`),
    index("mkt_tpl_created_by_idx").on(t.createdById),
    index("mkt_tpl_sg_template_idx")
      .on(t.sendgridTemplateId)
      .where(sql`sendgrid_template_id IS NOT NULL`),
  ],
);

/**
 * Phase 19 — Soft-lock for collaborative template editing.
 *
 * One row per template currently being edited. The acquiring tab/session
 * heartbeats every MARKETING_LOCK_HEARTBEAT_SECONDS (default 30); a lock
 * is considered stale once `heartbeat_at` is older than
 * MARKETING_LOCK_TIMEOUT_SECONDS (default 60). A second editor opening
 * the template sees a "locked by …" banner and is offered a read-only
 * view; admins can force-release.
 *
 * Single-row-per-template guarantees mutual exclusion at the SQL layer —
 * we use UPSERT with a transaction and FOR UPDATE to acquire.
 */
export const templateLocks = pgTable(
  "marketing_template_locks",
  {
    templateId: uuid("template_id")
      .primaryKey()
      .references(() => marketingTemplates.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("mkt_tpl_lock_heartbeat_idx").on(t.heartbeatAt.desc())],
);

export type MarketingTemplateStatus = "draft" | "ready" | "archived";
