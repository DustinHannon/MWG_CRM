import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { marketingTemplates } from "./marketing-templates";

/**
 * Phase 29 §7 — ClickDimensions template-migration worklist.
 *
 * One row per template extracted from the legacy ClickDimensions
 * surface in D365. The extraction script (tools/clickdimensions-
 * migration) walks the CRM UI in a headed Playwright browser, opens
 * each template, hands off to the editor-specific handler, captures
 * the rendered HTML, and POSTs the result to
 * `/api/v1/admin/migrations/clickdimensions/templates`.
 *
 * Each successful row also lands in `marketing_templates` with
 * `source='clickdimensions_migration'` and `scope='global'`; the
 * imported row's id is captured back here in `imported_template_id`
 * so admins can pivot from the worklist into the canonical template
 * editor.
 *
 * Idempotency: `(cd_template_id)` is unique. Re-extracting the same
 * D365 GUID updates the existing row in place — never inserts a duplicate.
 */

export const clickdimensionsEditorTypeEnum = pgEnum(
  "clickdimensions_editor_type",
  ["custom-html", "free-style", "email-designer", "drag-and-drop", "unknown"],
);

export const clickdimensionsMigrationStatusEnum = pgEnum(
  "clickdimensions_migration_status",
  ["pending", "extracted", "imported", "failed", "skipped"],
);

export const clickdimensionsMigrations = pgTable(
  "clickdimensions_migrations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** D365 template GUID — natural key for idempotent re-extraction. */
    cdTemplateId: uuid("cd_template_id").notNull().unique(),
    cdTemplateName: text("cd_template_name").notNull(),
    cdSubject: text("cd_subject"),
    cdCategory: text("cd_category"),
    cdOwner: text("cd_owner"),
    cdCreatedAt: timestamp("cd_created_at", { withTimezone: true }),
    cdModifiedAt: timestamp("cd_modified_at", { withTimezone: true }),
    editorType: clickdimensionsEditorTypeEnum("editor_type")
      .notNull()
      .default("unknown"),
    /** Captured HTML. May be large; we do not index this column. */
    rawHtml: text("raw_html"),
    status: clickdimensionsMigrationStatusEnum("status")
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /**
     * Set when this CD row was promoted into the canonical
     * `marketing_templates` table. SET NULL on deletion of the
     * imported template so the migration history persists even if
     * the imported row is later purged.
     */
    importedTemplateId: uuid("imported_template_id").references(
      () => marketingTemplates.id,
      { onDelete: "set null" },
    ),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("cd_mig_status_idx").on(t.status, t.extractedAt.desc()),
    index("cd_mig_extracted_idx").on(t.extractedAt.desc()),
    index("cd_mig_imported_idx").on(t.importedTemplateId),
  ],
);

export type ClickDimensionsEditorType =
  | "custom-html"
  | "free-style"
  | "email-designer"
  | "drag-and-drop"
  | "unknown";

export type ClickDimensionsMigrationStatus =
  | "pending"
  | "extracted"
  | "imported"
  | "failed"
  | "skipped";

export type ClickDimensionsMigrationRow =
  typeof clickdimensionsMigrations.$inferSelect;
