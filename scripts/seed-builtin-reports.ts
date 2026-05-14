/**
 * scripts/seed-builtin-reports.ts
 *
 * Idempotent seeder for the built-in reports catalog.
 *
 * Run:    pnpm dlx tsx --env-file .env.local scripts/seed-builtin-reports.ts
 *         (the project doesn't ship `tsx` as a dep — use dlx, or wire
 *         it up via `pnpm add -D tsx` if you'd rather)
 *
 *         Alternative for production: a SQL equivalent of this script
 *         lives committed alongside (see PHASE11-SUBC-REPORT.md) and
 *         was used to seed the production DB on first deploy.
 *
 * What it does:
 *   1. Look up (or create) a system service user `system@mwg.local`.
 *      Built-in reports are owned by that user so deleting a real
 *      person's account doesn't take the global reports with it.
 *   2. Upsert each built-in report by name where is_builtin = true.
 *      The lookup key is (name, is_builtin = true) so re-running this
 *      script is safe.
 *   3. All built-ins are flagged is_shared = true so every viewer sees
 *      them in /reports.
 *
 * Reports cover the 9 the brief lists:
 *   1. Pipeline by Stage
 *   2. Lead Source Performance
 *   3. Activity Volume by User
 *   4. Conversion Funnel
 *   5. Win/Loss Analysis
 *   6. Account Penetration
 *   7. Aging Leads
 *   8. Overdue Tasks
 *   9. Revenue Forecast
 *
 * Notes on the filter shape — `executeReport` accepts:
 *   { <field>: { eq | ilike | gte | lte | gt | lt | in } }
 * The "Pipeline by Stage" `notIn` request is implemented with an
 * IN-list of the active stages, since `notIn` isn't wired into the
 * filter builder yet.
 */
// NOTE: relies on --env-file or pre-set environment to populate
// POSTGRES_URL / AUTH_SECRET — the imported env validator will throw
// otherwise. We deliberately don't import dotenv here so the script
// stays fast under `pnpm dlx tsx`.
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../src/db";
import { savedReports } from "../src/db/schema/saved-reports";
import { users } from "../src/db/schema/users";

const SYSTEM_EMAIL = "system@mwg.local";
const SYSTEM_USERNAME = "system";

interface BuiltinReport {
  name: string;
  description: string;
  entityType:
    | "lead"
    | "account"
    | "contact"
    | "opportunity"
    | "activity"
    | "task"
    // marketing/email entities (admin + canManageMarketing only).
    | "marketing_campaign"
    | "marketing_email_event"
    | "email_send_log";
  fields: string[];
  filters: Record<string, Record<string, unknown>>;
  groupBy: string[];
  metrics: { fn: "count" | "sum" | "avg" | "min" | "max"; field?: string; alias: string }[];
  visualization:
    | "table"
    | "bar"
    | "line"
    | "pie"
    | "kpi"
    | "funnel";
}

const REPORTS: BuiltinReport[] = [
  {
    name: "Pipeline by Stage",
    description:
      "Open opportunities grouped by stage. Excludes closed_won and closed_lost.",
    entityType: "opportunity",
    fields: [],
    filters: {
      stage: {
        in: ["prospecting", "qualification", "proposal", "negotiation"],
      },
    },
    groupBy: ["stage"],
    metrics: [
      { fn: "sum", field: "amount", alias: "total_amount" },
      { fn: "count", alias: "count" },
    ],
    visualization: "bar",
  },
  {
    name: "Lead Source Performance",
    description: "Lead volume by acquisition source.",
    entityType: "lead",
    fields: [],
    filters: {},
    groupBy: ["source"],
    metrics: [{ fn: "count", alias: "leads" }],
    visualization: "bar",
  },
  {
    name: "Activity Volume by User",
    description: "Activities logged grouped by user.",
    entityType: "activity",
    fields: [],
    filters: {},
    groupBy: ["user_id"],
    metrics: [{ fn: "count", alias: "activities" }],
    visualization: "bar",
  },
  {
    name: "Conversion Funnel",
    description: "Lead counts by status — proxy for the conversion funnel.",
    entityType: "lead",
    fields: [],
    filters: {},
    groupBy: ["status"],
    metrics: [{ fn: "count", alias: "count" }],
    visualization: "funnel",
  },
  {
    name: "Win/Loss Analysis",
    description: "Closed opportunities split between won and lost stages.",
    entityType: "opportunity",
    fields: [],
    filters: {
      stage: { in: ["closed_won", "closed_lost"] },
    },
    groupBy: ["stage"],
    metrics: [
      { fn: "sum", field: "amount", alias: "total" },
      { fn: "count", alias: "count" },
    ],
    visualization: "pie",
  },
  {
    name: "Account Penetration",
    description: "Opportunities and total amount grouped by account.",
    entityType: "opportunity",
    fields: [],
    filters: {},
    groupBy: ["account_id"],
    metrics: [
      { fn: "count", alias: "opps" },
      { fn: "sum", field: "amount", alias: "total" },
    ],
    visualization: "table",
  },
  {
    name: "Aging Leads",
    description:
      "Leads sorted by last activity date — surfaces the entire list ordered so the oldest activity floats to the top.",
    entityType: "lead",
    fields: [
      "first_name",
      "last_name",
      "company_name",
      "status",
      "last_activity_at",
      "tags",
    ],
    filters: {},
    groupBy: [],
    metrics: [],
    visualization: "table",
  },
  {
    name: "Overdue Tasks",
    description:
      "Open and in-progress tasks whose due date has passed, grouped by assignee. Identifies workload concentration on the people carrying the most overdue work.",
    entityType: "task",
    fields: [],
    filters: {
      status: { in: ["open", "in_progress"] },
      due_at: { lt: "$now" },
    },
    groupBy: ["assigned_to_id"],
    metrics: [{ fn: "count", alias: "overdue" }],
    visualization: "bar",
  },
  {
    name: "Revenue Forecast",
    description: "Pipeline amount summed by stage.",
    entityType: "opportunity",
    fields: [],
    filters: {},
    groupBy: ["stage"],
    metrics: [{ fn: "sum", field: "amount", alias: "pipeline" }],
    visualization: "kpi",
  },
  // ----- Marketing / email built-ins -----
  // Visible only to admins + users with canManageMarketing per
  // src/lib/reports/access.ts assertCanViewReport gate.
  {
    name: "Campaign Performance",
    description:
      "Sends, opens, clicks, bounces, and unsubscribes per email campaign. Filter the date range on the report run page.",
    entityType: "marketing_campaign",
    fields: [
      "name",
      "status",
      "sent_at",
      "total_recipients",
      "total_sent",
      "total_delivered",
      "total_opened",
      "total_clicked",
      "total_bounced",
      "total_unsubscribed",
    ],
    filters: {},
    groupBy: [],
    metrics: [],
    visualization: "table",
  },
  {
    name: "Top Engaged Recipients",
    description:
      "Recipients ranked by total open + click count from SendGrid events. Higher counts = warmer marketing audience.",
    entityType: "marketing_email_event",
    fields: [],
    filters: { event_type: { in: ["open", "click"] } },
    groupBy: ["email"],
    metrics: [{ fn: "count", alias: "engagement_events" }],
    visualization: "bar",
  },
  {
    name: "Email Deliverability Issues",
    description:
      "Bounces, spam reports, blocks, and unsubscribes grouped by SendGrid event type. Trend this to spot deliverability regressions.",
    entityType: "marketing_email_event",
    fields: [],
    filters: {
      event_type: {
        in: ["bounce", "dropped", "spamreport", "blocked", "unsubscribe"],
      },
    },
    groupBy: ["event_type"],
    metrics: [{ fn: "count", alias: "events" }],
    visualization: "bar",
  },
  // ----- Second wave of marketing/email built-ins -----
  {
    name: "Template Usage",
    description:
      "Email templates ranked by number of campaigns that used them and total recipients reached. Use to spot templates that are over-used or never-used.",
    entityType: "marketing_campaign",
    fields: [],
    filters: {},
    groupBy: ["template_id"],
    metrics: [
      { fn: "count", alias: "campaign_count" },
      { fn: "sum", field: "total_recipients", alias: "total_recipients" },
      { fn: "sum", field: "total_sent", alias: "total_sent" },
      { fn: "sum", field: "total_opened", alias: "total_opened" },
    ],
    visualization: "table",
  },
  {
    name: "Sender Performance",
    description:
      "Campaigns grouped by the sender (from_email). Shows total sent, delivered, and opened per sender so you can compare which senders get higher engagement.",
    entityType: "marketing_campaign",
    fields: [],
    filters: { status: { eq: "sent" } },
    groupBy: ["from_email"],
    metrics: [
      { fn: "count", alias: "campaigns_sent" },
      { fn: "sum", field: "total_sent", alias: "total_sent" },
      { fn: "sum", field: "total_delivered", alias: "total_delivered" },
      { fn: "sum", field: "total_opened", alias: "total_opened" },
      { fn: "sum", field: "total_clicked", alias: "total_clicked" },
    ],
    visualization: "table",
  },
  {
    name: "Click Engagement by Campaign",
    description:
      "Click events from the SendGrid event stream grouped by campaign. Use to compare which campaigns drive the most click-throughs from recipients who opened.",
    entityType: "marketing_email_event",
    fields: [],
    filters: { event_type: { eq: "click" } },
    groupBy: ["campaign_id"],
    metrics: [{ fn: "count", alias: "clicks" }],
    visualization: "bar",
  },
  {
    name: "Bounce Reasons",
    description:
      "Top reasons SendGrid bounced or dropped email. Useful when deliverability dips — surfaces whether the issue is sender reputation, recipient mailbox state, or content filtering.",
    entityType: "marketing_email_event",
    fields: [],
    filters: { event_type: { in: ["bounce", "dropped", "blocked"] } },
    groupBy: ["reason"],
    metrics: [{ fn: "count", alias: "occurrences" }],
    visualization: "bar",
  },
];

async function ensureSystemUser(): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SYSTEM_EMAIL))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [created] = await db
    .insert(users)
    .values({
      username: SYSTEM_USERNAME,
      email: SYSTEM_EMAIL,
      firstName: "System",
      lastName: "Service",
      displayName: "System Service",
      isAdmin: false,
      isActive: false, // can never sign in
    })
    .returning({ id: users.id });
  return created.id;
}

async function upsertReport(ownerId: string, def: BuiltinReport) {
  const existing = await db
    .select({ id: savedReports.id })
    .from(savedReports)
    .where(
      and(eq(savedReports.name, def.name), eq(savedReports.isBuiltin, true)),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(savedReports)
      .set({
        description: def.description,
        entityType: def.entityType,
        fields: def.fields,
        filters: def.filters,
        groupBy: def.groupBy,
        metrics: def.metrics,
        visualization: def.visualization,
        isShared: true,
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        deleteReason: null,
        updatedAt: new Date(),
      })
      .where(eq(savedReports.id, existing[0].id));
    return { action: "updated", id: existing[0].id, name: def.name };
  }

  const [row] = await db
    .insert(savedReports)
    .values({
      ownerId,
      name: def.name,
      description: def.description,
      entityType: def.entityType,
      fields: def.fields,
      filters: def.filters,
      groupBy: def.groupBy,
      metrics: def.metrics,
      visualization: def.visualization,
      isShared: true,
      isBuiltin: true,
    })
    .returning({ id: savedReports.id });
  return { action: "inserted", id: row.id, name: def.name };
}

async function pruneRemoved(catalogNames: readonly string[]) {
  // Hard-delete any is_builtin=true rows whose name is no longer in the
  // catalog. Built-ins are owned by the system service user; users
  // can't mark their own reports as built-in, so the catalog is the
  // single source of truth for what should exist. Without this sweep,
  // removing an entry from REPORTS leaves an orphaned DB row that the
  // /reports page still surfaces with stale metadata.
  const removed = await db
    .delete(savedReports)
    .where(
      and(
        eq(savedReports.isBuiltin, true),
        notInArray(savedReports.name, [...catalogNames]),
      ),
    )
    .returning({ id: savedReports.id, name: savedReports.name });
  if (removed.length > 0) {
    for (const r of removed) {
      console.log(`[removed] ${r.name} (${r.id})`);
    }
  }
  return removed.length;
}

async function main() {
  console.log("=== Built-in reports seeder ===");
  const ownerId = await ensureSystemUser();
  console.log(`System service user: ${ownerId} (${SYSTEM_EMAIL})`);

  for (const def of REPORTS) {
    const res = await upsertReport(ownerId, def);
    console.log(`[${res.action}] ${res.name} (${res.id})`);
  }

  const removedCount = await pruneRemoved(REPORTS.map((r) => r.name));

  console.log(
    `\nDone. ${REPORTS.length} built-in reports in catalog` +
      (removedCount > 0 ? `; ${removedCount} stale rows pruned.` : "."),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seeder failed:", err);
  process.exit(1);
});
