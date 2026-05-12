import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { withApi } from "@/lib/api/handler";
import { errorResponse } from "@/lib/api/errors";
import {
  clickdimensionsMigrations,
  type ClickDimensionsEditorType,
} from "@/db/schema/clickdimensions-migrations";
import { marketingTemplates } from "@/db/schema/marketing-templates";
import { writeAudit } from "@/lib/audit";
import { MARKETING_AUDIT_EVENTS } from "@/lib/marketing/audit-events";
import { sessionFromKey } from "@/lib/api/v1/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Receives one extracted ClickDimensions template from the
 * local Playwright extraction script. Idempotent on `cd_template_id`.
 *
 * On `extracted` success the row is also promoted into
 * `marketing_templates` with `scope='global'`, `source='clickdimensions
 * _migration'`, `name='[CD] <cd_template_name>'`. The imported row's id
 * is captured back here for cross-reference.
 *
 * Auth: API key with scope `marketing.migrations.api` (or `admin`).
 */

const TemplatePayload = z.object({
  cdTemplateId: z.string().uuid(),
  cdTemplateName: z.string().min(1).max(500),
  cdSubject: z.string().max(2000).nullable().optional(),
  cdCategory: z.string().max(500).nullable().optional(),
  cdOwner: z.string().max(500).nullable().optional(),
  cdCreatedAt: z.string().datetime().nullable().optional(),
  cdModifiedAt: z.string().datetime().nullable().optional(),
  editorType: z
    .enum(["custom-html", "free-style", "email-designer", "drag-and-drop", "unknown"])
    .default("unknown"),
  rawHtml: z.string().nullable().optional(),
  // Optional reported status — defaults to 'extracted' on a successful
  // POST. Pass 'failed' or 'skipped' to record a non-extracting attempt.
  status: z
    .enum(["extracted", "failed", "skipped"])
    .default("extracted"),
  errorReason: z.string().max(2000).nullable().optional(),
});

type TemplatePayloadInput = z.infer<typeof TemplatePayload>;

function buildImportedTemplateName(cdTemplateName: string): string {
  return `[CD] ${cdTemplateName}`.slice(0, 500);
}

// Minimal Unlayer-shaped JSON so the existing template editor can open
// the row read-only. The captured HTML is the source of truth; the
// design JSON is a single "HTML" block.
function buildPlaceholderUnlayerDesign(html: string): Record<string, unknown> {
  return {
    body: {
      rows: [
        {
          cells: [1],
          columns: [
            {
              contents: [
                {
                  type: "html",
                  values: { html: html ?? "" },
                },
              ],
              values: {},
            },
          ],
          values: {},
        },
      ],
      values: {},
    },
  };
}

export const POST = withApi(
  {
    scope: "marketing.migrations.api",
    action: "marketing.migration.template.upsert",
  },
  async (req, { key }) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(422, "VALIDATION_ERROR", "Body must be valid JSON");
    }

    const parsed = TemplatePayload.safeParse(body);
    if (!parsed.success) {
      return errorResponse(422, "VALIDATION_ERROR", "Invalid payload", {
        details: parsed.error.errors.map((e) => ({
          field: e.path.join("."),
          issue: e.message,
        })),
      });
    }

    const p: TemplatePayloadInput = parsed.data;
    const user = await sessionFromKey(key);
    const now = new Date();

    // 1. Upsert the migration row. Conflict target: cd_template_id.
    const existingRows = await db
      .select()
      .from(clickdimensionsMigrations)
      .where(eq(clickdimensionsMigrations.cdTemplateId, p.cdTemplateId))
      .limit(1);
    const existing = existingRows[0] ?? null;

    const editorType = p.editorType as ClickDimensionsEditorType;
    const cdCreatedAt = p.cdCreatedAt ? new Date(p.cdCreatedAt) : null;
    const cdModifiedAt = p.cdModifiedAt ? new Date(p.cdModifiedAt) : null;

    let migrationRowId: string;
    if (!existing) {
      const inserted = await db
        .insert(clickdimensionsMigrations)
        .values({
          cdTemplateId: p.cdTemplateId,
          cdTemplateName: p.cdTemplateName,
          cdSubject: p.cdSubject ?? null,
          cdCategory: p.cdCategory ?? null,
          cdOwner: p.cdOwner ?? null,
          cdCreatedAt,
          cdModifiedAt,
          editorType,
          rawHtml: p.rawHtml ?? null,
          status: p.status,
          attempts: 1,
          extractedAt: p.status === "extracted" ? now : null,
          lastAttemptAt: now,
          errorReason: p.errorReason ?? null,
        })
        .returning({ id: clickdimensionsMigrations.id });
      migrationRowId = inserted[0]!.id;
    } else {
      await db
        .update(clickdimensionsMigrations)
        .set({
          cdTemplateName: p.cdTemplateName,
          cdSubject: p.cdSubject ?? existing.cdSubject,
          cdCategory: p.cdCategory ?? existing.cdCategory,
          cdOwner: p.cdOwner ?? existing.cdOwner,
          cdCreatedAt: cdCreatedAt ?? existing.cdCreatedAt,
          cdModifiedAt: cdModifiedAt ?? existing.cdModifiedAt,
          editorType,
          rawHtml: p.rawHtml ?? existing.rawHtml,
          status: p.status,
          attempts: (existing.attempts ?? 0) + 1,
          extractedAt:
            p.status === "extracted"
              ? now
              : existing.extractedAt,
          lastAttemptAt: now,
          errorReason: p.errorReason ?? null,
          updatedAt: now,
        })
        .where(eq(clickdimensionsMigrations.id, existing.id));
      migrationRowId = existing.id;
    }

    // 2. Audit the extraction event.
    if (p.status === "extracted") {
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_EXTRACTED,
        targetType: "clickdimensions_migration",
        targetId: migrationRowId,
        after: {
          cdTemplateId: p.cdTemplateId,
          editorType,
          htmlBytes: p.rawHtml ? p.rawHtml.length : 0,
        },
      });
    } else if (p.status === "failed") {
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_FAILED,
        targetType: "clickdimensions_migration",
        targetId: migrationRowId,
        after: {
          errorReason: p.errorReason ?? null,
          attempts: (existing?.attempts ?? 0) + 1,
          editorType,
        },
      });
    }

    // 3. If we got HTML, promote into marketing_templates. Idempotent:
    // if the migration row already has imported_template_id, update
    // the existing marketing_templates row in place. Otherwise
    // insert a new row and capture its id back.
    let importedTemplateId: string | null = existing?.importedTemplateId ?? null;
    if (p.status === "extracted" && p.rawHtml && p.rawHtml.length > 0) {
      const displayName = buildImportedTemplateName(p.cdTemplateName);
      const designJson = buildPlaceholderUnlayerDesign(p.rawHtml);
      const subject =
        p.cdSubject && p.cdSubject.length > 0 ? p.cdSubject : displayName;

      if (importedTemplateId) {
        // Update existing marketing_templates row (rare; re-extraction
        // path). The OCC version bump is intentionally not applied —
        // this is a system-driven update, not user-driven.
        await db
          .update(marketingTemplates)
          .set({
            name: displayName,
            subject,
            unlayerDesignJson: designJson,
            renderedHtml: p.rawHtml,
            updatedById: user.id,
            updatedAt: now,
          })
          .where(eq(marketingTemplates.id, importedTemplateId));
      } else {
        const insertedTpl = await db
          .insert(marketingTemplates)
          .values({
            name: displayName,
            description: p.cdCategory
              ? `Imported from ClickDimensions (category: ${p.cdCategory})`
              : "Imported from ClickDimensions",
            subject,
            preheader: null,
            unlayerDesignJson: designJson,
            renderedHtml: p.rawHtml,
            sendgridTemplateId: null,
            sendgridVersionId: null,
            status: "draft",
            // Sub-agent A added scope + source. We tag
            // source so the worklist UI can pivot back to this
            // migration row; scope='global' makes the imported row
            // visible to all marketing users.
            scope: "global",
            source: "clickdimensions_migration",
            createdById: user.id,
            updatedById: user.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: marketingTemplates.id });
        importedTemplateId = insertedTpl[0]!.id;
        await db
          .update(clickdimensionsMigrations)
          .set({
            importedTemplateId,
            status: "imported",
            updatedAt: now,
          })
          .where(eq(clickdimensionsMigrations.id, migrationRowId));
      }

      // Audit the import.
      await writeAudit({
        actorId: user.id,
        action: MARKETING_AUDIT_EVENTS.MIGRATION_TEMPLATE_IMPORTED,
        targetType: "marketing_template",
        targetId: importedTemplateId,
        after: {
          cdTemplateId: p.cdTemplateId,
          cdMigrationId: migrationRowId,
          editorType,
        },
      });
    }

    return Response.json(
      {
        ok: true,
        id: migrationRowId,
        cdTemplateId: p.cdTemplateId,
        status: importedTemplateId ? "imported" : p.status,
        importedTemplateId,
      },
      { status: existing ? 200 : 201 },
    );
  },
);

// Guard against undeclared verbs landing as 405-from-Next defaults.
export async function GET(): Promise<Response> {
  return errorResponse(
    405,
    "VALIDATION_ERROR",
    "Method Not Allowed — use POST",
  );
}

