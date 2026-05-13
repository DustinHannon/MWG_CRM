import "server-only";
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { emailSendLog } from "@/db/schema/email-send-log";
import { users } from "@/db/schema/users";
import {
  decodeCursor as decodeStandardCursor,
  encodeFromValues as encodeStandardCursor,
} from "@/lib/cursors";

/**
 * Row shape returned by `listEmailFailuresCursor`. Mirrors the columns
 * the admin email-failures page renders. Timestamps are serialized to
 * ISO strings at the API boundary; this server-side shape carries
 * Date.
 */
export interface EmailFailureRow {
  id: string;
  queuedAt: Date;
  sentAt: Date | null;
  fromUserId: string;
  fromUserEmailSnapshot: string;
  fromUserDisplayName: string | null;
  toEmail: string;
  toUserId: string | null;
  feature: string;
  featureRecordId: string | null;
  subject: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  graphMessageId: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  requestId: string | null;
  retryOfId: string | null;
  metadata: Record<string, unknown> | null;
  hasAttachments: boolean;
  attachmentCount: number;
  totalSizeBytes: number | null;
}

export const FAILURE_STATUSES = ["failed", "blocked_preflight"] as const;
export type FailureStatus = (typeof FAILURE_STATUSES)[number];

export interface EmailFailuresCursorFilters {
  status?: FailureStatus | "all";
  since: Date;
  feature?: string;
  errorCode?: string;
  fromUserId?: string;
}

/**
 * Cursor-paginated list of email send failures.
 *
 * Default sort: `(queued_at DESC, id DESC)`. The partial index
 * `email_send_status_idx` on `(status, queued_at DESC)` filtered to
 * failure statuses backs the page-wide filter.
 */
export async function listEmailFailuresCursor(args: {
  filters: EmailFailuresCursorFilters;
  cursor: string | null;
  pageSize?: number;
}): Promise<{
  data: EmailFailureRow[];
  nextCursor: string | null;
  total: number;
}> {
  const pageSize = args.pageSize ?? 100;
  const { filters } = args;

  const wheres: SQL[] = [];

  // Always restrict to failure-shaped rows.
  if (filters.status === "all" || !filters.status) {
    wheres.push(inArray(emailSendLog.status, ["failed", "blocked_preflight"]));
  } else {
    wheres.push(eq(emailSendLog.status, filters.status));
  }
  wheres.push(gte(emailSendLog.queuedAt, filters.since));

  if (filters.feature) wheres.push(eq(emailSendLog.feature, filters.feature));
  if (filters.errorCode) {
    wheres.push(eq(emailSendLog.errorCode, filters.errorCode));
  }
  if (filters.fromUserId) {
    wheres.push(eq(emailSendLog.fromUserId, filters.fromUserId));
  }

  const baseWhere = and(...wheres);

  const parsedCursor = decodeStandardCursor(args.cursor, "desc");
  const cursorWhere = (() => {
    if (!parsedCursor) return undefined;
    if (parsedCursor.ts === null) return undefined;
    return sql`(
      ${emailSendLog.queuedAt} < ${parsedCursor.ts.toISOString()}::timestamptz
      OR (${emailSendLog.queuedAt} = ${parsedCursor.ts.toISOString()}::timestamptz AND ${emailSendLog.id} < ${parsedCursor.id}::uuid)
    )`;
  })();

  const finalWhere = cursorWhere ? and(baseWhere, cursorWhere) : baseWhere;

  const [rowsRaw, totalRow] = await Promise.all([
    db
      .select({
        id: emailSendLog.id,
        queuedAt: emailSendLog.queuedAt,
        sentAt: emailSendLog.sentAt,
        fromUserId: emailSendLog.fromUserId,
        fromUserEmailSnapshot: emailSendLog.fromUserEmailSnapshot,
        fromUserDisplayName: users.displayName,
        toEmail: emailSendLog.toEmail,
        toUserId: emailSendLog.toUserId,
        feature: emailSendLog.feature,
        featureRecordId: emailSendLog.featureRecordId,
        subject: emailSendLog.subject,
        status: emailSendLog.status,
        errorCode: emailSendLog.errorCode,
        errorMessage: emailSendLog.errorMessage,
        graphMessageId: emailSendLog.graphMessageId,
        httpStatus: emailSendLog.httpStatus,
        durationMs: emailSendLog.durationMs,
        requestId: emailSendLog.requestId,
        retryOfId: emailSendLog.retryOfId,
        metadata: emailSendLog.metadata,
        hasAttachments: emailSendLog.hasAttachments,
        attachmentCount: emailSendLog.attachmentCount,
        totalSizeBytes: emailSendLog.totalSizeBytes,
      })
      .from(emailSendLog)
      .leftJoin(users, eq(emailSendLog.fromUserId, users.id))
      .where(finalWhere)
      .orderBy(desc(emailSendLog.queuedAt), desc(emailSendLog.id))
      .limit(pageSize + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailSendLog)
      .where(baseWhere),
  ]);

  let nextCursor: string | null = null;
  let data = rowsRaw;
  if (rowsRaw.length > pageSize) {
    data = rowsRaw.slice(0, pageSize);
    const last = data[data.length - 1];
    nextCursor = encodeStandardCursor(last.queuedAt, last.id, "desc");
  }

  return {
    data: data.map((r) => ({
      ...r,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
    nextCursor,
    total: totalRow[0]?.count ?? 0,
  };
}

/**
 * Distinct feature / error-code / sender lists for the filter
 * dropdowns. Scoped to failure rows since the date `since`.
 */
export async function listEmailFailureFacets(since: Date): Promise<{
  features: string[];
  errorCodes: string[];
  senders: Array<{ id: string; email: string }>;
}> {
  const [featureRows, errorCodeRows, senderRows] = await Promise.all([
    db
      .selectDistinct({ feature: emailSendLog.feature })
      .from(emailSendLog)
      .where(
        and(
          inArray(emailSendLog.status, ["failed", "blocked_preflight"]),
          gte(emailSendLog.queuedAt, since),
        ),
      )
      .orderBy(asc(emailSendLog.feature)),
    db
      .selectDistinct({ errorCode: emailSendLog.errorCode })
      .from(emailSendLog)
      .where(
        and(
          inArray(emailSendLog.status, ["failed", "blocked_preflight"]),
          gte(emailSendLog.queuedAt, since),
          sql`${emailSendLog.errorCode} IS NOT NULL`,
        ),
      )
      .orderBy(asc(emailSendLog.errorCode)),
    db
      .selectDistinct({
        id: emailSendLog.fromUserId,
        email: emailSendLog.fromUserEmailSnapshot,
      })
      .from(emailSendLog)
      .where(
        and(
          inArray(emailSendLog.status, ["failed", "blocked_preflight"]),
          gte(emailSendLog.queuedAt, since),
        ),
      )
      .orderBy(asc(emailSendLog.fromUserEmailSnapshot)),
  ]);

  return {
    features: featureRows
      .map((r) => r.feature)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
    errorCodes: errorCodeRows
      .map((r) => r.errorCode)
      .filter((v): v is string => typeof v === "string" && v.length > 0),
    senders: senderRows
      .map((r) => ({ id: r.id, email: r.email }))
      .filter((s) => s.id && s.email),
  };
}
