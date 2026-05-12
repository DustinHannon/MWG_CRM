import "server-only";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { savedReports, type SavedReport } from "@/db/schema/saved-reports";
import { users } from "@/db/schema/users";
import { NotFoundError } from "@/lib/errors";

/**
 * repository helpers for the reports feature.
 *
 * Pure data fetchers; permission gating happens in
 * `lib/reports/access.ts` and at the API layer.
 */

export async function getReportById(id: string): Promise<SavedReport | null> {
  const rows = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getReportByIdOrThrow(id: string): Promise<SavedReport> {
  const r = await getReportById(id);
  if (!r) throw new NotFoundError("report");
  return r;
}

export interface ReportListItem {
  id: string;
  name: string;
  description: string | null;
  entityType: string;
  visualization: string;
  isShared: boolean;
  isBuiltin: boolean;
  ownerId: string;
  ownerName: string | null;
  updatedAt: Date;
}

export async function listBuiltinReports(): Promise<ReportListItem[]> {
  const rows = await db
    .select({
      id: savedReports.id,
      name: savedReports.name,
      description: savedReports.description,
      entityType: savedReports.entityType,
      visualization: savedReports.visualization,
      isShared: savedReports.isShared,
      isBuiltin: savedReports.isBuiltin,
      ownerId: savedReports.ownerId,
      ownerName: users.displayName,
      updatedAt: savedReports.updatedAt,
    })
    .from(savedReports)
    .leftJoin(users, eq(users.id, savedReports.ownerId))
    .where(
      and(
        eq(savedReports.isBuiltin, true),
        eq(savedReports.isDeleted, false),
      ),
    )
    .orderBy(savedReports.name);
  return rows;
}

/**
 * "Your reports + shared" — owned by viewer or shared with team.
 * Excludes built-in (rendered separately) and excludes soft-deleted.
 */
export async function listUserAndSharedReports(
  viewerId: string,
): Promise<ReportListItem[]> {
  const rows = await db
    .select({
      id: savedReports.id,
      name: savedReports.name,
      description: savedReports.description,
      entityType: savedReports.entityType,
      visualization: savedReports.visualization,
      isShared: savedReports.isShared,
      isBuiltin: savedReports.isBuiltin,
      ownerId: savedReports.ownerId,
      ownerName: users.displayName,
      updatedAt: savedReports.updatedAt,
    })
    .from(savedReports)
    .leftJoin(users, eq(users.id, savedReports.ownerId))
    .where(
      and(
        eq(savedReports.isBuiltin, false),
        eq(savedReports.isDeleted, false),
        or(
          eq(savedReports.ownerId, viewerId),
          eq(savedReports.isShared, true),
        ),
      ),
    )
    .orderBy(desc(savedReports.updatedAt));
  return rows;
}

