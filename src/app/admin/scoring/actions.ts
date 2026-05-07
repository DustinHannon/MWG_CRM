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
import { logger } from "@/lib/logger";
import {
  evaluateLead,
  invalidateThresholdCache,
  rescoreAllLeads,
} from "@/lib/scoring/engine";
import { db as dbAlias } from "@/db";
import { leads } from "@/db/schema/leads";

void dbAlias;

/**
 * Phase 5B — admin scoring CRUD + threshold management.
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

export async function createScoringRuleAction(
  raw: z.input<typeof CREATE_RULE>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = CREATE_RULE.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  try {
    const inserted = await db
      .insert(leadScoringRules)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        predicate: parsed.data.predicate,
        points: parsed.data.points,
        isActive: parsed.data.isActive,
        createdById: session.id,
      })
      .returning({ id: leadScoringRules.id });
    await writeAudit({
      actorId: session.id,
      action: "scoring.rule_create",
      targetType: "lead_scoring_rules",
      targetId: inserted[0].id,
      after: parsed.data as Record<string, unknown>,
    });
    revalidatePath("/admin/scoring");
    return { ok: true, id: inserted[0].id };
  } catch (err) {
    logger.error("scoring.rule_create_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not create rule." };
  }
}

export async function updateScoringRuleAction(
  raw: z.input<typeof UPDATE_RULE>,
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  const session = await requireAdmin();
  const parsed = UPDATE_RULE.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  try {
    const set: Record<string, unknown> = {
      updatedAt: sql`now()`,
      version: sql`${leadScoringRules.version} + 1`,
    };
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    if (parsed.data.description !== undefined)
      set.description = parsed.data.description;
    if (parsed.data.predicate !== undefined)
      set.predicate = parsed.data.predicate;
    if (parsed.data.points !== undefined) set.points = parsed.data.points;
    if (parsed.data.isActive !== undefined) set.isActive = parsed.data.isActive;

    const result = await db
      .update(leadScoringRules)
      .set(set)
      .where(
        sql`${leadScoringRules.id} = ${parsed.data.id}::uuid AND ${leadScoringRules.version} = ${parsed.data.expectedVersion}`,
      )
      .returning({ id: leadScoringRules.id });

    if (result.length === 0) {
      return {
        ok: false,
        error:
          "This rule was modified by someone else. Refresh and try again.",
        code: "CONFLICT",
      };
    }

    await writeAudit({
      actorId: session.id,
      action: "scoring.rule_update",
      targetType: "lead_scoring_rules",
      targetId: parsed.data.id,
      after: parsed.data as Record<string, unknown>,
    });
    revalidatePath("/admin/scoring");
    return { ok: true };
  } catch (err) {
    logger.error("scoring.rule_update_failed", {
      ruleId: parsed.data.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not update rule." };
  }
}

export async function deleteScoringRuleAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  try {
    await db.delete(leadScoringRules).where(eq(leadScoringRules.id, id));
    await writeAudit({
      actorId: session.id,
      action: "scoring.rule_delete",
      targetType: "lead_scoring_rules",
      targetId: id,
    });
    revalidatePath("/admin/scoring");
    return { ok: true };
  } catch (err) {
    logger.error("scoring.rule_delete_failed", {
      ruleId: id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not delete rule." };
  }
}

export async function setScoringThresholdsAction(
  raw: z.input<typeof SET_THRESHOLDS>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAdmin();
  const parsed = SET_THRESHOLDS.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  if (
    !(
      parsed.data.hotThreshold > parsed.data.warmThreshold &&
      parsed.data.warmThreshold > parsed.data.coolThreshold
    )
  ) {
    return {
      ok: false,
      error: "Hot must be greater than Warm; Warm must be greater than Cool.",
    };
  }
  try {
    await db
      .update(leadScoringSettings)
      .set({
        hotThreshold: parsed.data.hotThreshold,
        warmThreshold: parsed.data.warmThreshold,
        coolThreshold: parsed.data.coolThreshold,
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
      after: parsed.data as Record<string, unknown>,
    });
    revalidatePath("/admin/scoring");
    return { ok: true };
  } catch (err) {
    logger.error("scoring.thresholds_update_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not update thresholds." };
  }
}

export async function recomputeAllScoresAction(): Promise<
  { ok: true; processed: number } | { ok: false; error: string }
> {
  const session = await requireAdmin();
  try {
    const totalCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(eq(leads.isDeleted, false));
    const total = totalCount[0]?.n ?? 0;
    if (total > 10_000) {
      return {
        ok: false,
        error: `Manual recompute capped at 10,000 leads (current: ${total}). Tonight's nightly cron will pick this up.`,
      };
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
    return { ok: true, processed };
  } catch (err) {
    logger.error("scoring.recompute_manual_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not recompute scores." };
  }
}

void evaluateLead;
