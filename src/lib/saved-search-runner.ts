import "server-only";
import { logger } from "@/lib/logger";
import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { savedViews, userPreferences } from "@/db/schema/views";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { createNotification } from "@/lib/notifications";
import { sendDigestEmail, type DigestRecord } from "@/lib/digest-email";
import { formatPersonName } from "@/lib/format/person-name";
import { permissions } from "@/db/schema/users";

type SubRow = {
  id: string;
  userId: string;
  viewId: string;
  viewName: string;
  filters: unknown;
  scope: string;
  entityType: string;
  frequency: string;
  lastSeenMaxCreatedAt: Date | null;
  emailDigestFreq: string;
  notifyInApp: boolean;
  isAdmin: boolean;
  canViewAllRecords: boolean;
} & Record<string, unknown>;

/**
 * The five subscribable saved-view domains. `saved_views.entity_type`
 * is constrained to these values by `saved_views_entity_type_valid`.
 * Each maps to a per-entity matcher below. `label` / `pluralLabel`
 * feed the in-app notification + email subject (sentence-case nouns);
 * `route` builds the per-record and saved-view deep links.
 */
const ENTITY_META: Record<
  string,
  { label: string; pluralLabel: string; route: string }
> = {
  lead: { label: "lead", pluralLabel: "leads", route: "leads" },
  account: { label: "account", pluralLabel: "accounts", route: "accounts" },
  contact: { label: "contact", pluralLabel: "contacts", route: "contacts" },
  opportunity: {
    label: "opportunity",
    pluralLabel: "opportunities",
    route: "opportunities",
  },
  task: { label: "task", pluralLabel: "tasks", route: "tasks" },
};

/**
 * Matched rows are normalized to `DigestRecord` so the notification +
 * email layers stay entity-agnostic. `createdAt` is carried so the
 * caller can advance the per-subscription cursor.
 */
type MatchRecord = DigestRecord & { createdAt: Date };

/**
 * runner. Daily cron:
 * select active subs whose frequency matches today (daily always;
 * weekly only if last_run_at null or >= 7 days ago)
 * for each, run the view's filters against rows of the subscribed
 * entity created since last_seen_max_created_at
 * if matches: always create in-app notification, optionally send
 * email if user's email_digest_frequency matches
 */
export interface DigestSummary {
  processed: number;
  notified: number;
  emailed: number;
  reauth: number;
  errors: number;
}

export async function runSavedSearchDigest(): Promise<DigestSummary> {
  const summary: DigestSummary = {
    processed: 0,
    notified: 0,
    emailed: 0,
    reauth: 0,
    errors: 0,
  };

  const subs = (await db.execute<SubRow>(sql`
    SELECT
      s.id,
      s.user_id AS "userId",
      s.saved_view_id AS "viewId",
      sv.name AS "viewName",
      sv.filters,
      sv.scope,
      sv.entity_type AS "entityType",
      s.frequency,
      s.last_seen_max_created_at AS "lastSeenMaxCreatedAt",
      coalesce(p.email_digest_frequency, 'off') AS "emailDigestFreq",
      coalesce(p.notify_saved_search, true) AS "notifyInApp",
      u.is_admin AS "isAdmin",
      coalesce(perm.can_view_all_records, false) AS "canViewAllRecords"
    FROM saved_search_subscriptions s
    INNER JOIN saved_views sv ON sv.id = s.saved_view_id
    INNER JOIN users u ON u.id = s.user_id
    LEFT JOIN user_preferences p ON p.user_id = s.user_id
    LEFT JOIN permissions perm ON perm.user_id = s.user_id
    WHERE s.is_active = true
      AND u.is_active = true
      AND (
        s.frequency = 'daily'
        OR (s.frequency = 'weekly' AND (s.last_run_at IS NULL OR s.last_run_at < now() - interval '7 days'))
      )
  `)) as unknown as SubRow[];

  for (const sub of subs) {
    summary.processed += 1;
    try {
      const entity = ENTITY_META[sub.entityType] ?? ENTITY_META.lead;
      const cutoff =
        sub.lastSeenMaxCreatedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

      let matches: MatchRecord[];
      switch (sub.entityType) {
        case "account":
          matches = await matchAccounts(sub, cutoff);
          break;
        case "contact":
          matches = await matchContacts(sub, cutoff);
          break;
        case "opportunity":
          matches = await matchOpportunities(sub, cutoff);
          break;
        case "task":
          matches = await matchTasks(sub, cutoff);
          break;
        case "lead":
        default:
          matches = await matchLeads(sub, cutoff);
          break;
      }

      const newCutoff =
        matches.length > 0
          ? matches.reduce(
              (max, r) => (r.createdAt > max ? r.createdAt : max),
              matches[0].createdAt,
            )
          : sub.lastSeenMaxCreatedAt ?? new Date();

      // Always update last_run_at; only bump cutoff if we actually saw rows.
      await db
        .update(savedSearchSubscriptions)
        .set({
          lastRunAt: new Date(),
          lastSeenMaxCreatedAt: newCutoff,
        })
        .where(eq(savedSearchSubscriptions.id, sub.id));

      if (matches.length === 0) continue;

      const noun =
        matches.length === 1 ? entity.label : entity.pluralLabel;

      // respect the user's notify_saved_search preference. The
      // email digest runs through its own pref below regardless.
      if (sub.notifyInApp) {
        await createNotification({
          userId: sub.userId,
          kind: "saved_search",
          title: `${matches.length} new ${noun} matching "${sub.viewName}"`,
          link: `/${entity.route}?view=saved:${sub.viewId}`,
        });
        summary.notified += 1;
      }

      // email-digest gate. The per-sub `frequency`
      // is authoritative for cadence (the WHERE clause above already
      // picks up only the subs running today). The user's
      // `email_digest_frequency` is now just a global emit-or-not
      // toggle: 'off' → suppress emails entirely (in-app still fires
      // if notifySavedSearch is on), 'daily' or 'weekly' → emit emails
      // for every sub that runs today, regardless of which value.
      // The earlier "freq must match" check is gone — that constraint
      // confused users when their global default was 'weekly' but
      // they wanted a daily sub on a specific high-priority view.
      const wantsEmail = sub.emailDigestFreq !== "off";
      if (wantsEmail) {
        try {
          await sendDigestEmail({
            userId: sub.userId,
            viewName: sub.viewName,
            entityLabel: entity.label,
            entityPluralLabel: entity.pluralLabel,
            subscriptionId: sub.id,
            records: matches.map((r) => ({
              id: r.id,
              name: r.name,
              company: r.company,
              ownerName: r.ownerName,
              link: r.link,
            })),
          });
          summary.emailed += 1;
        } catch (err) {
          // sendEmailAs no longer throws ReauthRequiredError
          // (app permissions bypass per-user refresh tokens). Real
          // delivery failures are logged in email_send_log and
          // surfaced on /admin/email-failures. This catch only fires
          // on programming errors.
          summary.errors += 1;
          logger.error("digest.email_send_failed", {
            userId: sub.userId,
            entityType: sub.entityType,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      summary.errors += 1;
      logger.error("digest.sub_run_failed", {
        subscriptionId: sub.id,
        entityType: sub.entityType,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/* ----------------------------------------------------------------------------
 * Per-entity matchers. Each finds rows of its entity created since
 * `cutoff`, applies the saved view's stored filters, enforces the
 * `scope='mine'` owner gate (admins / can_view_all_records bypass it),
 * and excludes archived rows (`is_deleted=false`). Filter keys mirror
 * the per-entity `*ViewFilters` shapes used by the list pages so a
 * subscription matches exactly what the list page would show. The
 * enum-cast / tag-EXISTS forms are copied verbatim from the canonical
 * `run*View` builders (the ANY-array record-cast hardening landed in
 * commit 6cb517f — do not hand-roll a variant).
 * ------------------------------------------------------------------------- */

/** Owner-scope predicate: only applied when scope='mine' and the user
 * is neither an admin nor can-view-all. Generalized across entities by
 * passing the entity's owner column. */
function ownerScopeWhere(
  sub: SubRow,
  ownerColumn: Parameters<typeof eq>[0],
): SQL | undefined {
  if (sub.scope === "mine" && !sub.isAdmin && !sub.canViewAllRecords) {
    return eq(ownerColumn, sub.userId);
  }
  return undefined;
}

async function matchLeads(
  sub: SubRow,
  cutoff: Date,
): Promise<MatchRecord[]> {
  const filters = (sub.filters ?? {}) as {
    status?: string[];
    rating?: string[];
    source?: string[];
    search?: string;
  };

  // exclude archived leads from saved-search digest. The
  // pre-fix runner emailed users about leads that had since been
  // archived, surfacing rows the user may have explicitly hidden.
  const wheres: SQL[] = [
    gt(leads.createdAt, cutoff),
    eq(leads.isDeleted, false),
  ];
  if (filters.status && filters.status.length > 0) {
    // status enum, raw cast
    wheres.push(
      sql`${leads.status}::text = ANY(ARRAY[${sql.join(filters.status.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  if (filters.rating && filters.rating.length > 0) {
    wheres.push(
      sql`${leads.rating}::text = ANY(ARRAY[${sql.join(filters.rating.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  if (filters.source && filters.source.length > 0) {
    wheres.push(
      sql`${leads.source}::text = ANY(ARRAY[${sql.join(filters.source.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  const scope = ownerScopeWhere(sub, leads.ownerId);
  if (scope) wheres.push(scope);

  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      createdAt: leads.createdAt,
      ownerName: users.displayName,
    })
    .from(leads)
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(and(...wheres))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    name: formatPersonName(r),
    company: r.companyName,
    ownerName: r.ownerName,
    link: `/leads/${r.id}`,
    createdAt: r.createdAt,
  }));
}

async function matchAccounts(
  sub: SubRow,
  cutoff: Date,
): Promise<MatchRecord[]> {
  const filters = (sub.filters ?? {}) as {
    search?: string;
    owner?: string[];
    industry?: string[];
    city?: string;
    state?: string;
    country?: string;
    hasParentAccount?: boolean;
    tags?: string[];
  };

  const wheres: SQL[] = [
    gt(crmAccounts.createdAt, cutoff),
    eq(crmAccounts.isDeleted, false),
  ];
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(
      sql`(${crmAccounts.name} ILIKE ${pattern} OR ${crmAccounts.website} ILIKE ${pattern} OR ${crmAccounts.email} ILIKE ${pattern} OR ${crmAccounts.industry} ILIKE ${pattern} OR ${crmAccounts.accountNumber} ILIKE ${pattern})`,
    );
  }
  if (filters.owner && filters.owner.length > 0) {
    wheres.push(inArray(crmAccounts.ownerId, filters.owner));
  }
  if (filters.industry && filters.industry.length > 0) {
    wheres.push(inArray(crmAccounts.industry, filters.industry));
  }
  if (filters.city) {
    wheres.push(sql`${crmAccounts.city} ILIKE ${`%${filters.city}%`}`);
  }
  if (filters.state) {
    wheres.push(eq(crmAccounts.state, filters.state));
  }
  if (filters.country) {
    wheres.push(eq(crmAccounts.country, filters.country));
  }
  if (filters.hasParentAccount === true) {
    wheres.push(sql`${crmAccounts.parentAccountId} IS NOT NULL`);
  } else if (filters.hasParentAccount === false) {
    wheres.push(sql`${crmAccounts.parentAccountId} IS NULL`);
  }
  if (filters.tags && filters.tags.length > 0) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM account_tags at
        JOIN tags t ON t.id = at.tag_id
        WHERE at.account_id = ${crmAccounts.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(ARRAY[${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)}]::text[]) AS x
        )
      )`,
    );
  }
  const scope = ownerScopeWhere(sub, crmAccounts.ownerId);
  if (scope) wheres.push(scope);

  const rows = await db
    .select({
      id: crmAccounts.id,
      name: crmAccounts.name,
      createdAt: crmAccounts.createdAt,
      ownerName: users.displayName,
    })
    .from(crmAccounts)
    .leftJoin(users, eq(users.id, crmAccounts.ownerId))
    .where(and(...wheres))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    company: null,
    ownerName: r.ownerName,
    link: `/accounts/${r.id}`,
    createdAt: r.createdAt,
  }));
}

async function matchContacts(
  sub: SubRow,
  cutoff: Date,
): Promise<MatchRecord[]> {
  const filters = (sub.filters ?? {}) as {
    search?: string;
    owner?: string[];
    account?: string[];
    doNotContact?: boolean;
    doNotEmail?: boolean;
    doNotCall?: boolean;
    doNotMail?: boolean;
    city?: string;
    state?: string;
    country?: string;
    tags?: string[];
  };

  const wheres: SQL[] = [
    gt(contacts.createdAt, cutoff),
    eq(contacts.isDeleted, false),
  ];
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(
      sql`(${contacts.firstName} ILIKE ${pattern} OR ${contacts.lastName} ILIKE ${pattern} OR ${contacts.email} ILIKE ${pattern} OR ${contacts.jobTitle} ILIKE ${pattern})`,
    );
  }
  if (filters.owner && filters.owner.length > 0) {
    wheres.push(inArray(contacts.ownerId, filters.owner));
  }
  if (filters.account && filters.account.length > 0) {
    wheres.push(inArray(contacts.accountId, filters.account));
  }
  if (filters.doNotContact !== undefined) {
    wheres.push(eq(contacts.doNotContact, filters.doNotContact));
  }
  if (filters.doNotEmail !== undefined) {
    wheres.push(eq(contacts.doNotEmail, filters.doNotEmail));
  }
  if (filters.doNotCall !== undefined) {
    wheres.push(eq(contacts.doNotCall, filters.doNotCall));
  }
  if (filters.doNotMail !== undefined) {
    wheres.push(eq(contacts.doNotMail, filters.doNotMail));
  }
  if (filters.city) {
    wheres.push(sql`${contacts.city} ILIKE ${`%${filters.city}%`}`);
  }
  if (filters.state) {
    wheres.push(eq(contacts.state, filters.state));
  }
  if (filters.country) {
    wheres.push(eq(contacts.country, filters.country));
  }
  if (filters.tags && filters.tags.length > 0) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM contact_tags ct
        JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ${contacts.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(ARRAY[${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)}]::text[]) AS x
        )
      )`,
    );
  }
  const scope = ownerScopeWhere(sub, contacts.ownerId);
  if (scope) wheres.push(scope);

  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      accountName: crmAccounts.name,
      createdAt: contacts.createdAt,
      ownerName: users.displayName,
    })
    .from(contacts)
    .leftJoin(crmAccounts, eq(crmAccounts.id, contacts.accountId))
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(...wheres))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    name: formatPersonName(r),
    company: r.accountName,
    ownerName: r.ownerName,
    link: `/contacts/${r.id}`,
    createdAt: r.createdAt,
  }));
}

async function matchOpportunities(
  sub: SubRow,
  cutoff: Date,
): Promise<MatchRecord[]> {
  const filters = (sub.filters ?? {}) as {
    search?: string;
    owner?: string[];
    account?: string[];
    stage?: string[];
    tags?: string[];
  };

  const wheres: SQL[] = [
    gt(opportunities.createdAt, cutoff),
    eq(opportunities.isDeleted, false),
  ];
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    wheres.push(sql`${opportunities.name} ILIKE ${pattern}`);
  }
  if (filters.owner && filters.owner.length > 0) {
    wheres.push(inArray(opportunities.ownerId, filters.owner));
  }
  if (filters.account && filters.account.length > 0) {
    wheres.push(inArray(opportunities.accountId, filters.account));
  }
  if (filters.stage && filters.stage.length > 0) {
    wheres.push(
      sql`${opportunities.stage}::text = ANY(ARRAY[${sql.join(filters.stage.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  if (filters.tags && filters.tags.length > 0) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM opportunity_tags ot
        JOIN tags t ON t.id = ot.tag_id
        WHERE ot.opportunity_id = ${opportunities.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(ARRAY[${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)}]::text[]) AS x
        )
      )`,
    );
  }
  const scope = ownerScopeWhere(sub, opportunities.ownerId);
  if (scope) wheres.push(scope);

  const rows = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      accountName: crmAccounts.name,
      createdAt: opportunities.createdAt,
      ownerName: users.displayName,
    })
    .from(opportunities)
    .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .leftJoin(users, eq(users.id, opportunities.ownerId))
    .where(and(...wheres))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    company: r.accountName,
    ownerName: r.ownerName,
    link: `/opportunities/${r.id}`,
    createdAt: r.createdAt,
  }));
}

async function matchTasks(
  sub: SubRow,
  cutoff: Date,
): Promise<MatchRecord[]> {
  const filters = (sub.filters ?? {}) as {
    assignee?: string;
    status?: string[];
    priority?: string[];
    q?: string;
    tags?: string[];
  };

  const wheres: SQL[] = [
    gt(tasks.createdAt, cutoff),
    eq(tasks.isDeleted, false),
  ];
  if (filters.status && filters.status.length > 0) {
    wheres.push(
      sql`${tasks.status}::text = ANY(ARRAY[${sql.join(filters.status.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  if (filters.priority && filters.priority.length > 0) {
    wheres.push(
      sql`${tasks.priority}::text = ANY(ARRAY[${sql.join(filters.priority.map((v) => sql`${v}`), sql`, `)}]::text[])`,
    );
  }
  if (filters.q && filters.q.trim()) {
    wheres.push(sql`${tasks.title} ILIKE ${`%${filters.q.trim()}%`}`);
  }
  // Assignee filter mirrors the task list page: 'me' → the
  // subscriber, a UUID → that user, 'any'/absent → no assignee
  // constraint.
  if (filters.assignee === "me") {
    wheres.push(eq(tasks.assignedToId, sub.userId));
  } else if (
    filters.assignee &&
    filters.assignee !== "any" &&
    filters.assignee.length > 0
  ) {
    wheres.push(eq(tasks.assignedToId, filters.assignee));
  }
  if (filters.tags && filters.tags.length > 0) {
    wheres.push(
      sql`EXISTS (
        SELECT 1 FROM task_tags tt
        JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id = ${tasks.id} AND lower(t.name) = ANY(
          SELECT lower(x) FROM unnest(ARRAY[${sql.join(filters.tags.map((t) => sql`${t}`), sql`, `)}]::text[]) AS x
        )
      )`,
    );
  }
  // Tasks have no owner column; "mine" scopes to the assignee. Admins
  // / can-view-all see all matching tasks (same gate shape as the
  // other entities, just keyed on assigned_to_id).
  if (
    sub.scope === "mine" &&
    !sub.isAdmin &&
    !sub.canViewAllRecords &&
    filters.assignee !== "me"
  ) {
    wheres.push(eq(tasks.assignedToId, sub.userId));
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      createdAt: tasks.createdAt,
      ownerName: users.displayName,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assignedToId))
    .where(and(...wheres))
    .limit(50);

  return rows.map((r) => ({
    id: r.id,
    name: r.title,
    company: null,
    ownerName: r.ownerName,
    link: `/tasks/${r.id}`,
    createdAt: r.createdAt,
  }));
}

void permissions;
void userPreferences;
