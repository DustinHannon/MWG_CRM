import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import {
  leadScoringRules,
  leadScoringSettings,
} from "@/db/schema/lead-scoring";
import { leads } from "@/db/schema/leads";
import { logger } from "@/lib/logger";

/**
 * lead scoring engine.
 *
 * Predicate format mirrors saved-views filters so admins can use the same
 * UI to build rules. Each rule has a `predicate` (JSONB), a `points` value
 * (can be negative), and an `is_active` flag. The engine sums `points` for
 * every active rule whose predicate matches a lead, then maps the total to
 * a band defined in `lead_scoring_settings` (defaults: hot ≥ 70, warm
 * 40–69, cool 15–39, cold < 15).
 *
 *
 * Thresholds now read from `lead_scoring_settings` (single-row),
 * cached for 60s in-process to keep the rescore loop fast.
 * Activity aggregation is restricted to counting kinds (note, call,
 * email, meeting, task) explicitly. Imports + lead-create no longer
 * touch `leads.last_activity_at`, so freshly-imported leads have
 * `activity_count=0` and don't match recency rules.
 * New pseudo-field `has_no_activity` for explicit "no activity ever"
 * rules.
 *
 * Supported operators:
 * eq, neq, lt, lte, gt, gte, in, not_in, contains (string),
 * is_null, is_not_null
 *
 * Pseudo-fields (joined data):
 * last_activity_within_days (number | null) — days since last counting
 * activity. `null` when no counting activities; `<=` / `>=` clauses
 * against null return false.
 * activity_count (number) — total counting-activity count.
 * has_no_activity (boolean) — true iff `activity_count === 0`.
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
  // Numeric lead columns backed by Postgres `numeric` (e.g.
  // estimatedValue) come back as JS strings because the postgres-js
  // client runs with `fetch_types: false`. Coerce a string left
  // operand to a number for the ordering operators so range rules on
  // those columns actually fire; a non-finite result fails the guard
  // and the clause returns false, exactly as a non-numeric value
  // should.
  const leftNum = typeof left === "string" ? Number(left) : left;
  switch (c.op) {
    case "eq":
      return left === c.value;
    case "neq":
      return left !== c.value;
    case "lt":
      return (
        typeof leftNum === "number" &&
        Number.isFinite(leftNum) &&
        typeof c.value === "number" &&
        leftNum < c.value
      );
    case "lte":
      return (
        typeof leftNum === "number" &&
        Number.isFinite(leftNum) &&
        typeof c.value === "number" &&
        leftNum <= c.value
      );
    case "gt":
      return (
        typeof leftNum === "number" &&
        Number.isFinite(leftNum) &&
        typeof c.value === "number" &&
        leftNum > c.value
      );
    case "gte":
      return (
        typeof leftNum === "number" &&
        Number.isFinite(leftNum) &&
        typeof c.value === "number" &&
        leftNum >= c.value
      );
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

/** An active scoring rule as loaded for evaluation. */
type ScoringRule = { id: string; predicate: unknown; points: number };

/**
 * Load the active scoring-rule set. Returned shape is the minimum the
 * evaluator needs. Lifted out of `evaluateLead` so the batch rescore can
 * load it ONCE per run and reuse it across every lead instead of
 * re-scanning the table per lead (the app DB client is `max: 1`, so per-
 * lead scans serialize on one connection and dominate the nightly run).
 */
async function loadActiveRules(): Promise<ScoringRule[]> {
  return db
    .select({
      id: leadScoringRules.id,
      predicate: leadScoringRules.predicate,
      points: leadScoringRules.points,
    })
    .from(leadScoringRules)
    .where(eq(leadScoringRules.isActive, true));
}

/**
 * Score a single lead. Loads the lead, joins activity stats, runs every
 * active rule, persists the score + band + scored_at.
 *
 * @param leadId UUID of the lead to score.
 * @param rules Pre-loaded active rule set. Pass it from a batch caller
 *   to avoid re-scanning `lead_scoring_rules` per lead; omit it for the
 *   single-lead admin recompute path and the function self-loads.
 * @returns The new {score, band} or null if the lead doesn't exist.
 */
export async function evaluateLead(
  leadId: string,
  rules?: ScoringRule[],
): Promise<
  { score: number; band: ReturnType<typeof bandFor> } | null
> {
  // Filter archived (soft-deleted) leads — a deleted lead should never
  // be re-scored. The cron path already filters via `rescoreAllLeads`,
  // but `evaluateLead` is exported and can be called directly (admin
  // single-lead recompute, future on-demand scoring). Without the
  // guard a deleted lead's score keeps drifting from real activity
  // counts as new (orphaned) activities arrive.
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.isDeleted, false)))
    .limit(1);
  if (!lead) return null;

  // Counting kinds are explicit so future non-counting kinds (e.g.
  // 'system') don't silently leak into the engagement signal.
  // Soft-deleted activities are also excluded — a user who archives
  // a misattributed call should see the score drop next eval.
  const [agg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${activities.occurredAt})`,
    })
    .from(activities)
    .where(
      and(
        eq(activities.leadId, leadId),
        eq(activities.isDeleted, false),
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

  const activeRules = rules ?? (await loadActiveRules());

  let total = 0;
  for (const r of activeRules) {
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
  // Load the active rule set once for the whole run and reuse it across
  // every lead — the set is identical for every lead in a run, and the
  // `max: 1` pooler serializes a per-lead re-scan into the dominant cost.
  const rules = await loadActiveRules();
  // Pageable cursor by ascending id so we don't re-process within the run.
  while (true) {
    const batch = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.isDeleted, false),
          lastId ? gt(leads.id, lastId) : undefined,
        ),
      )
      .orderBy(leads.id)
      .limit(100);

    if (batch.length === 0) break;

    for (const r of batch) {
      try {
        await evaluateLead(r.id, rules);
        processed++;
      } catch (err) {
        logger.warn("scoring.lead_eval_failed", {
          leadId: r.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (batch.length < 100) break;
    lastId = batch[batch.length - 1].id;
  }
  return processed;
}
