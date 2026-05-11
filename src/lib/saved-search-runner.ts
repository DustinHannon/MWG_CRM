import "server-only";
import { logger } from "@/lib/logger";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { savedViews, userPreferences } from "@/db/schema/views";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { users } from "@/db/schema/users";
import { createNotification } from "@/lib/notifications";
import { sendDigestEmail } from "@/lib/digest-email";
import { formatPersonName } from "@/lib/format/person-name";
import { permissions } from "@/db/schema/users";

type SubRow = {
  id: string;
  userId: string;
  viewId: string;
  viewName: string;
  filters: unknown;
  scope: string;
  frequency: string;
  lastSeenMaxCreatedAt: Date | null;
  emailDigestFreq: string;
  notifyInApp: boolean;
  isAdmin: boolean;
  canViewAllRecords: boolean;
} & Record<string, unknown>;

/**
 * Phase 3H runner. Daily cron:
 *   - select active subs whose frequency matches today (daily always;
 *     weekly only if last_run_at null or >= 7 days ago)
 *   - for each, run filter against leads created since last_seen_max_created_at
 *   - if matches: always create in-app notification, optionally send
 *     email if user's email_digest_frequency matches
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
      const filters = (sub.filters ?? {}) as {
        status?: string[];
        rating?: string[];
        source?: string[];
        search?: string;
      };

      const cutoff =
        sub.lastSeenMaxCreatedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Phase 11 — exclude archived leads from saved-search digest. The
      // pre-fix runner emailed users about leads that had since been
      // archived, surfacing rows the user may have explicitly hidden.
      const wheres = [gt(leads.createdAt, cutoff), eq(leads.isDeleted, false)];
      if (filters.status && filters.status.length > 0) {
        // status enum, raw cast
        wheres.push(
          sql`${leads.status}::text = ANY(${filters.status}::text[])`,
        );
      }
      if (filters.rating && filters.rating.length > 0) {
        wheres.push(
          sql`${leads.rating}::text = ANY(${filters.rating}::text[])`,
        );
      }
      if (filters.source && filters.source.length > 0) {
        wheres.push(
          sql`${leads.source}::text = ANY(${filters.source}::text[])`,
        );
      }
      if (sub.scope === "mine" && !sub.isAdmin && !sub.canViewAllRecords) {
        wheres.push(eq(leads.ownerId, sub.userId));
      }

      const matches = await db
        .select({
          id: leads.id,
          firstName: leads.firstName,
          lastName: leads.lastName,
          companyName: leads.companyName,
          ownerId: leads.ownerId,
          createdAt: leads.createdAt,
          ownerName: users.displayName,
        })
        .from(leads)
        .leftJoin(users, eq(users.id, leads.ownerId))
        .where(and(...wheres))
        .limit(50);

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

      // Phase 5A — respect the user's notify_saved_search preference. The
      // email digest runs through its own pref below regardless.
      if (sub.notifyInApp) {
        await createNotification({
          userId: sub.userId,
          kind: "saved_search",
          title: `${matches.length} new lead${matches.length === 1 ? "" : "s"} matching "${sub.viewName}"`,
          link: `/leads?view=saved:${sub.viewId}`,
        });
        summary.notified += 1;
      }

      // Phase 25 §7.2 — email-digest gate. The per-sub `frequency`
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
            records: matches.map((r) => ({
              id: r.id,
              name: formatPersonName(r),
              company: r.companyName,
              ownerName: r.ownerName,
              link: `/leads/${r.id}`,
            })),
          });
          summary.emailed += 1;
        } catch (err) {
          // Phase 15 — sendEmailAs no longer throws ReauthRequiredError
          // (app permissions bypass per-user refresh tokens). Real
          // delivery failures are logged in email_send_log and
          // surfaced on /admin/email-failures. This catch only fires
          // on programming errors.
          summary.errors += 1;
          logger.error("digest.email_send_failed", {
            userId: sub.userId,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      summary.errors += 1;
      logger.error("digest.sub_run_failed", {
        subscriptionId: sub.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

void inArray;
void permissions;
void userPreferences;
