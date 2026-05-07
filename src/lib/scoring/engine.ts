import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import {
  leadScoringRules,
  leadScoringSettings,
} from "@/db/schema/lead-scoring";
import { leads } from "@/db/schema/leads";
import { logger } from "@/lib/logger";

/**
 * Phase 4C — lead scoring engine.
 *
 * Predicate format mirrors saved-views filters so admins can use the same
 * UI to build rules. Each rule has a `predicate` (JSONB), a `points` value
 * (can be negative), and an `is_active` flag. The engine sums `points` for
 * every active rule whose predicate matches a lead, then maps the total to
 * a band defined in `lead_scoring_settings` (defaults: hot ≥ 70, warm
 * 40–69, cool 15–39, cold < 15).
 *
 * Phase 5B —
 *   - Thresholds now read from `lead_scoring_settings` (single-row),
 *     cached for 60s in-process to keep the rescore loop fast.
 *   - Activity aggregation is restricted to counting kinds (note, call,
 *     email, meeting, task) explicitly. Imports + lead-create no longer
 *     touch `leads.last_activity_at`, so freshly-imported leads have
 *     `activity_count=0` and don't match recency rules.
 *   - New pseudo-field `has_no_activity` for explicit "no activity ever"
 *     rules.
 *
 * Supported operators:
 *   eq, neq, lt, lte, gt, gte, in, not_in, contains (string),
 *   is_null, is_not_null
 *
 * Pseudo-fields (joined data):
 *   last_activity_within_days (number | null) — days since last counting
 *     activity. `null` when no counting activities; `<=` / `>=` clauses
 *     against null return false.
 *   activity_count (number)  — total counting-activity count.
 *   has_no_activity (boolean) — true iff `activity_count === 0`.
 */

type Op =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "not_in"
  | "contains"
  | "is_null"
  | "is_not_null";

interface Clause {
  field: string;
  op: Op;
  value?: unknown;
}

interface Predicate {
  all?: Clause[];
  any?: Clause[];
}

interface LeadFact {
  [k: string]: unknown;
  activity_count: number;
  last_activity_within_days: number | null;
  has_no_activity: boolean;
}

interface Thresholds {
  hot: number;
  warm: number;
  cool: number;
}

const DEFAULT_THRESHOLDS: Thresholds = { hot: 70, warm: 40, cool: 15 };

let thresholdCache: { value: Thresholds; loadedAt: number } | null = null;
const THRESHOLD_TTL_MS = 60_000;

async function getThresholds(): Promise<Thresholds> {
  const now = Date.now();
  if (thresholdCache && now - thresholdCache.loadedAt < THRESHOLD_TTL_MS) {
    return thresholdCache.value;
  }
  const rows = await db
    .select({
      hot: leadScoringSettings.hotThreshold,
      warm: leadScoringSettings.warmThreshold,
      cool: leadScoringSettings.coolThreshold,
    })
    .from(leadScoringSettings)
    .limit(1);
  const value = rows[0] ?? DEFAULT_THRESHOLDS;
  thresholdCache = { value, loadedAt: now };
  return value;
}

/**
 * Force the threshold cache to reload on the next read. Called from the
 * /admin/scoring server action after the sliders are saved so a manual
 * recompute uses the just-saved values without waiting for the TTL.
 */
export function invalidateThresholdCache(): void {
  thresholdCache = null;
}

function bandFor(
  score: number,
  t: Thresholds,
): "hot" | "warm" | "cool" | "cold" {
  if (score >= t.hot) return "hot";
  if (score >= t.warm) return "warm";
  if (score >= t.cool) return "cool";
  return "cold";
}

function clauseMatches(c: Clause, fact: LeadFact): boolean {
  const left = fact[c.field];
  switch (c.op) {
    case "eq":
      return left === c.value;
    case "neq":
      return left !== c.value;
    case "lt":
      return typeof left === "number" && typeof c.value === "number" && left < c.value;
    case "lte":
      return typeof left === "number" && typeof c.value === "number" && left <= c.value;
    case "gt":
      return typeof left === "number" && typeof c.value === "number" && left > c.value;
    case "gte":
      return typeof left === "number" && typeof c.value === "number" && left >= c.value;
    case "in":
      return Array.isArray(c.value) && c.value.includes(left as never);
    case "not_in":
      return Array.isArray(c.value) && !c.value.includes(left as never);
    case "contains":
      return (
        typeof left === "string" &&
        typeof c.value === "string" &&
        left.toLowerCase().includes(c.value.toLowerCase())
      );
    case "is_null":
      return left === null || left === undefined;
    case "is_not_null":
      return left !== null && left !== undefined;
    default:
      return false;
  }
}

function predicateMatches(p: Predicate, fact: LeadFact): boolean {
  if (p.all && !p.all.every((c) => clauseMatches(c, fact))) return false;
  if (p.any && !p.any.some((c) => clauseMatches(c, fact))) return false;
  // Empty predicate matches all leads (admins can use this for a baseline).
  return Boolean(p.all?.length || p.any?.length);
}

/**
 * Score a single lead. Loads the lead, joins activity stats, runs every
 * active rule, persists the score + band + scored_at.
 *
 * @param leadId  UUID of the lead to score.
 * @returns The new {score, band} or null if the lead doesn't exist.
 */
export async function evaluateLead(leadId: string): Promise<
  { score: number; band: ReturnType<typeof bandFor> } | null
> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return null;

  // Counting kinds are explicit so future non-counting kinds (e.g.
  // 'system') don't silently leak into the engagement signal.
  const [agg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${activities.occurredAt})`,
    })
    .from(activities)
    .where(
      and(
        eq(activities.leadId, leadId),
        inArray(activities.kind, [
          "note",
          "call",
          "email",
          "meeting",
          "task",
        ]),
      ),
    );

  const activity_count = agg?.n ?? 0;
  const lastAtMs = agg?.lastAt ? new Date(agg.lastAt).getTime() : null;
  const last_activity_within_days =
    lastAtMs == null ? null : Math.floor((Date.now() - lastAtMs) / 86_400_000);

  const fact: LeadFact = {
    ...(lead as Record<string, unknown>),
    activity_count,
    last_activity_within_days,
    has_no_activity: activity_count === 0,
  };

  const rules = await db
    .select()
    .from(leadScoringRules)
    .where(eq(leadScoringRules.isActive, true));

  let total = 0;
  for (const r of rules) {
    try {
      if (predicateMatches(r.predicate as Predicate, fact)) {
        total += r.points;
      }
    } catch (err) {
      logger.warn("scoring.rule_eval_failed", {
        ruleId: r.id,
        leadId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const thresholds = await getThresholds();
  const band = bandFor(total, thresholds);
  await db
    .update(leads)
    .set({ score: total, scoreBand: band, scoredAt: sql`now()` })
    .where(eq(leads.id, leadId));

  return { score: total, band };
}

/**
 * Re-score every non-archived lead. Used by the nightly cron and the
 * admin "Recompute all" button. Streams in batches of 100 to avoid memory
 * spikes; sequential to avoid hammering the DB.
 *
 * @returns total leads processed
 */
export async function rescoreAllLeads(): Promise<number> {
  let processed = 0;
  let lastId: string | null = null;
  // Pageable cursor by ascending id so we don't re-process within the run.
  while (true) {
    const batch = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.isDeleted, false),
          lastId ? gte(leads.id, lastId) : undefined,
        ),
      )
      .orderBy(leads.id)
      .limit(101);

    const slice = lastId ? batch.slice(1, 101) : batch.slice(0, 100);
    if (slice.length === 0) break;

    for (const r of slice) {
      try {
        await evaluateLead(r.id);
        processed++;
      } catch (err) {
        logger.warn("scoring.lead_eval_failed", {
          leadId: r.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (batch.length < 101) break;
    lastId = batch[100].id;
  }
  return processed;
}
