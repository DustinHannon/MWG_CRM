import "server-only";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";

/**
 * server library backing the user-display components and
 * the /users/[id] profile page.
 *
 * Auth model (per the brief): any signed-in user can fetch any other
 * user's basic profile (display name, title, dept, lead count, etc.).
 * Sensitive fields (password_hash, refresh_token, session_version)
 * are never returned. Caller is responsible for `requireSession()`
 * before calling — these helpers don't gate, they just project.
 */

export interface UserProfileSummary {
  user: {
    id: string;
    displayName: string;
    firstName: string;
    lastName: string | null;
    photoUrl: string | null;
    jobTitle: string | null;
    department: string | null;
    email: string;
    managerDisplayName: string | null;
    managerEmail: string | null;
    isActive: boolean;
  };
  stats: {
    openLeads: number;
    openOpportunities: number;
    lastLoginAt: Date | null;
  };
}

/**
 * Lightweight summary used by the hover card. Fast (single user row +
 * two count queries). Cached in-process for 60s by user id to avoid
 * hammering the DB when many chips are visible at once.
 */
const summaryCache = new Map<string, { value: UserProfileSummary; expires: number }>();
const SUMMARY_TTL_MS = 60_000;

export async function getUserProfileSummary(
  userId: string,
): Promise<UserProfileSummary | null> {
  const now = Date.now();
  const cached = summaryCache.get(userId);
  if (cached && cached.expires > now) return cached.value;

  const [u] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      photoUrl: users.photoBlobUrl,
      jobTitle: users.jobTitle,
      department: users.department,
      email: users.email,
      managerDisplayName: users.managerDisplayName,
      managerEmail: users.managerEmail,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!u) return null;

  // Open leads (status NOT converted/lost/unqualified) owned by user.
  // Open opportunities (stage not closed_won/closed_lost) owned by user.
  const [openLeadsRow, openOppsRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(leads)
      .where(
        and(
          eq(leads.ownerId, userId),
          sql`${leads.status} NOT IN ('converted','lost','unqualified')`,
        ),
      ),
    db
      .select({ n: count() })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.ownerId, userId),
          sql`${opportunities.stage}::text NOT IN ('closed_won','closed_lost')`,
        ),
      ),
  ]);

  const value: UserProfileSummary = {
    user: {
      id: u.id,
      displayName: u.displayName,
      firstName: u.firstName,
      lastName: u.lastName,
      photoUrl: u.photoUrl,
      jobTitle: u.jobTitle,
      department: u.department,
      email: u.email,
      managerDisplayName: u.managerDisplayName,
      managerEmail: u.managerEmail,
      isActive: u.isActive,
    },
    stats: {
      openLeads: openLeadsRow[0]?.n ?? 0,
      openOpportunities: openOppsRow[0]?.n ?? 0,
      lastLoginAt: u.lastLoginAt,
    },
  };

  summaryCache.set(userId, { value, expires: now + SUMMARY_TTL_MS });
  return value;
}

export interface UserProfilePage {
  user: UserProfileSummary["user"];
  stats: {
    openLeads: number;
    openOpportunities: number;
    activitiesAuthored: number;
    lastLoginAt: Date | null;
  };
  recentActivity: Array<{
    id: string;
    kind: string;
    subject: string | null;
    occurredAt: Date;
    leadId: string | null;
    accountId: string | null;
    contactId: string | null;
    opportunityId: string | null;
    leadName: string | null;
    accountName: string | null;
  }>;
}

/**
 * Full profile page payload. Adds activitiesAuthored count + last 20
 * recent activity rows joined to their parent records for linking.
 */
export async function getUserProfilePage(
  userId: string,
): Promise<UserProfilePage | null> {
  const summary = await getUserProfileSummary(userId);
  if (!summary) return null;

  // Activities authored across all parent types. Exclude archived /
  // cascade-soft-deleted activities so a user profile never counts or
  // links activity that was removed (directly or via a parent
  // entity's cascade-archive).
  const [authoredRow] = await db
    .select({ n: count() })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.isDeleted, false),
      ),
    );

  // Last 20 activities authored by user with parent names for linking.
  const recent = await db
    .select({
      id: activities.id,
      kind: sql<string>`${activities.kind}::text`,
      subject: activities.subject,
      occurredAt: activities.occurredAt,
      leadId: activities.leadId,
      accountId: activities.accountId,
      contactId: activities.contactId,
      opportunityId: activities.opportunityId,
      leadFirstName: leads.firstName,
      leadLastName: leads.lastName,
      accountName: crmAccounts.name,
    })
    .from(activities)
    .leftJoin(leads, eq(leads.id, activities.leadId))
    .leftJoin(crmAccounts, eq(crmAccounts.id, activities.accountId))
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.isDeleted, false),
      ),
    )
    .orderBy(desc(activities.occurredAt))
    .limit(20);

  return {
    user: summary.user,
    stats: {
      openLeads: summary.stats.openLeads,
      openOpportunities: summary.stats.openOpportunities,
      activitiesAuthored: authoredRow?.n ?? 0,
      lastLoginAt: summary.stats.lastLoginAt,
    },
    recentActivity: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      occurredAt: r.occurredAt,
      leadId: r.leadId,
      accountId: r.accountId,
      contactId: r.contactId,
      opportunityId: r.opportunityId,
      leadName:
        r.leadFirstName || r.leadLastName
          ? [r.leadFirstName, r.leadLastName].filter(Boolean).join(" ")
          : null,
      accountName: r.accountName,
    })),
  };
}

/**
 * Owned leads — paginated. Reused by the profile page's leads tab.
 * Cursor is `lastUpdatedAt:lastId` for stable pagination at scale.
 */
export interface OwnedLeadRow {
  id: string;
  firstName: string;
  lastName: string | null;
  companyName: string | null;
  status: string;
  rating: string;
  updatedAt: Date;
}

export async function listOwnedLeads(
  userId: string,
  pageSize = 50,
): Promise<OwnedLeadRow[]> {
  const rows = await db
    .select({
      id: leads.id,
      firstName: leads.firstName,
      lastName: leads.lastName,
      companyName: leads.companyName,
      status: sql<string>`${leads.status}::text`,
      rating: sql<string>`${leads.rating}::text`,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .where(and(eq(leads.ownerId, userId), eq(leads.isDeleted, false)))
    .orderBy(desc(leads.updatedAt), desc(leads.id))
    .limit(pageSize);
  return rows;
}

export interface OwnedOpportunityRow {
  id: string;
  name: string;
  stage: string;
  amount: string | null;
  expectedCloseDate: string | null;
  accountId: string | null;
  accountName: string | null;
  updatedAt: Date;
}

export async function listOwnedOpportunities(
  userId: string,
  pageSize = 50,
): Promise<OwnedOpportunityRow[]> {
  const rows = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      stage: sql<string>`${opportunities.stage}::text`,
      amount: opportunities.amount,
      expectedCloseDate: opportunities.expectedCloseDate,
      accountId: opportunities.accountId,
      accountName: crmAccounts.name,
      updatedAt: opportunities.updatedAt,
    })
    .from(opportunities)
    .leftJoin(crmAccounts, eq(crmAccounts.id, opportunities.accountId))
    .where(
      and(eq(opportunities.ownerId, userId), eq(opportunities.isDeleted, false)),
    )
    .orderBy(desc(opportunities.updatedAt), desc(opportunities.id))
    .limit(pageSize);
  return rows;
}
