"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  leadScoringRules,
  leadScoringSettings,
} from "@/db/schema/lead-scoring";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  evaluateLead,
  invalidateThresholdCache,
  rescoreAllLeads,
} from "@/lib/scoring/engine";
import { db as dbAlias } from "@/db";
import { leads } from "@/db/schema/leads";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

void dbAlias;

/**
 * admin scoring CRUD + threshold management.
 *
 * Every action is gated by `requireAdmin` and writes an audit row.
 * Threshold writes invalidate the in-process cache so the next
 * `evaluateLead` reads the new values.
 */

const PREDICATE_OP = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "contains",
  "is_null",
  "is_not_null",
]);

const PREDICATE_CLAUSE = z.object({
  field: z.string().trim().min(1).max(80),
  op: PREDICATE_OP,
  value: z.unknown().optional(),
});

const PREDICATE_SCHEMA = z.object({
  all: z.array(PREDICATE_CLAUSE).optional(),
  any: z.array(PREDICATE_CLAUSE).optional(),
});

const CREATE_RULE = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  predicate: PREDICATE_SCHEMA,
  points: z.number().int().min(-100).max(100),
  isActive: z.boolean().default(true),
});

const UPDATE_RULE = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  predicate: PREDICATE_SCHEMA.optional(),
  points: z.number().int().min(-100).max(100).optional(),
  isActive: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
});

const SET_THRESHOLDS = z.object({
  hotThreshold: z.number().int().min(-1000).max(1000),
  warmThreshold: z.number().int().min(-1000).max(1000),
  coolThreshold: z.number().int().min(-1000).max(1000),
});

export interface ScoringRuleIdData {
  id: string;
}
export interface RecomputeData {
  processed: number;
}

export async function createScoringRuleAction(
  raw: z.input<typeof CREATE_RULE>,
): Promise<ActionResult<ScoringRuleIdData>> {
  return withErrorBoundary(
    { action: "scoring.rule_create" },
    async (): Promise<ScoringRuleIdData> => {
      const session = await requireAdmin();
      const parsed = CREATE_RULE.parse(raw);
      const inserted = await db
        .insert(leadScoringRules)
        .values({
          name: parsed.name,
          description: parsed.description ?? null,
          predicate: parsed.predicate,
          points: parsed.points,
          isActive: parsed.isActive,
          createdById: session.id,
        })
        .returning({ id: leadScoringRules.id });
      await writeAudit({
        actorId: session.id,
        action: "scoring.rule_create",
        targetType: "lead_scoring_rules",
        targetId: inserted[0].id,
        after: parsed as Record<string, unknown>,
      });
      revalidatePath("/admin/scoring");
      return { id: inserted[0].id };
    },
  );
}

export async function updateScoringRuleAction(
  raw: z.input<typeof UPDATE_RULE>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "scoring.rule_update" },
    async () => {
      const session = await requireAdmin();
      const parsed = UPDATE_RULE.parse(raw);
      const set: Record<string, unknown> = {
        updatedAt: sql`now()`,
        version: sql`${leadScoringRules.version} + 1`,
      };
      if (parsed.name !== undefined) set.name = parsed.name;
      if (parsed.description !== undefined) set.description = parsed.description;
      if (parsed.predicate !== undefined) set.predicate = parsed.predicate;
      if (parsed.points !== undefined) set.points = parsed.points;
      if (parsed.isActive !== undefined) set.isActive = parsed.isActive;

      const result = await db
        .update(leadScoringRules)
        .set(set)
        .where(
          sql`${leadScoringRules.id} = ${parsed.id}::uuid AND ${leadScoringRules.version} = ${parsed.expectedVersion}`,
        )
        .returning({ id: leadScoringRules.id });

      if (result.length === 0) {
        throw new ConflictError(
          "This rule was modified by someone else. Refresh and try again.",
        );
      }

      await writeAudit({
        actorId: session.id,
        action: "scoring.rule_update",
        targetType: "lead_scoring_rules",
        targetId: parsed.id,
        after: parsed as Record<string, unknown>,
      });
      revalidatePath("/admin/scoring");
    },
  );
}

export async function deleteScoringRuleAction(
  id: string,
): Promise<ActionResult> {
  return withErrorBoundary(
    {
      action: "scoring.rule_delete",
      entityType: "lead_scoring_rules",
      entityId: id,
    },
    async () => {
      const session = await requireAdmin();
      await db.delete(leadScoringRules).where(eq(leadScoringRules.id, id));
      await writeAudit({
        actorId: session.id,
        action: "scoring.rule_delete",
        targetType: "lead_scoring_rules",
        targetId: id,
      });
      revalidatePath("/admin/scoring");
    },
  );
}

export async function setScoringThresholdsAction(
  raw: z.input<typeof SET_THRESHOLDS>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "scoring.thresholds_update" },
    async () => {
      const session = await requireAdmin();
      const parsed = SET_THRESHOLDS.parse(raw);
      if (
        !(
          parsed.hotThreshold > parsed.warmThreshold &&
          parsed.warmThreshold > parsed.coolThreshold
        )
      ) {
        throw new ValidationError(
          "Hot must be greater than Warm; Warm must be greater than Cool.",
        );
      }
      await db
        .update(leadScoringSettings)
        .set({
          hotThreshold: parsed.hotThreshold,
          warmThreshold: parsed.warmThreshold,
          coolThreshold: parsed.coolThreshold,
          updatedById: session.id,
          updatedAt: sql`now()`,
          version: sql`${leadScoringSettings.version} + 1`,
        })
        .where(eq(leadScoringSettings.id, 1));
      invalidateThresholdCache();
      await writeAudit({
        actorId: session.id,
        action: "scoring.thresholds_update",
        targetType: "lead_scoring_settings",
        targetId: "1",
        after: parsed as Record<string, unknown>,
      });
      revalidatePath("/admin/scoring");
    },
  );
}

export async function recomputeAllScoresAction(): Promise<
  ActionResult<RecomputeData>
> {
  return withErrorBoundary(
    { action: "scoring.recompute_manual" },
    async (): Promise<RecomputeData> => {
      const session = await requireAdmin();
      const totalCount = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(leads)
        .where(eq(leads.isDeleted, false));
      const total = totalCount[0]?.n ?? 0;
      if (total > 10_000) {
        throw new ValidationError(
          `Manual recompute capped at 10,000 leads (current: ${total}). Tonight's nightly cron will pick this up.`,
        );
      }
      invalidateThresholdCache();
      const processed = await rescoreAllLeads();
      await writeAudit({
        actorId: session.id,
        action: "scoring.recompute_manual",
        targetType: "leads",
        targetId: "all",
        after: { processed } as Record<string, unknown>,
      });
      revalidatePath("/admin/scoring");
      revalidatePath("/dashboard");
      return { processed };
    },
  );
}

void evaluateLead;
