import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailSendLog } from "@/db/schema/email-send-log";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs/breadcrumbs-setter";
import { RetentionBanner } from "@/components/admin/retention-banner";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { encodeCursor, parseCursor } from "@/lib/leads";
import { EmailFailuresClient } from "./email-failures-client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const RANGE_VALUES = ["24h", "7d", "30d", "90d"] as const;
type RangeValue = (typeof RANGE_VALUES)[number];

const STATUS_VALUES = ["all", "failed", "blocked_preflight"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

interface EmailFailuresSearchParams {
  from?: string;
  status?: string;
  feature?: string;
  errorCode?: string;
  fromUser?: string;
  cursor?: string;
}

export interface FailureRow {
  id: string;
  queuedAt: string;
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
  sentAt: string | null;
}

export default async function EmailFailuresPage({
  searchParams,
}: {
  searchParams: Promise<EmailFailuresSearchParams>;
}) {
  const sp = await searchParams;

  const range: RangeValue = (RANGE_VALUES as readonly string[]).includes(
    sp.from ?? "",
  )
    ? (sp.from as RangeValue)
    : "7d";
  const since = rangeToDate(range);

  const statusFilter: StatusFilter = (STATUS_VALUES as readonly string[]).includes(
    sp.status ?? "",
  )
    ? (sp.status as StatusFilter)
    : "all";

  const wheres: ReturnType<typeof and>[] = [];

  // Always restrict to failure-shaped rows — that's the whole point of this
  // page. The partial index `email_send_status_idx` covers exactly these
  // two statuses, so the filter is also fast.
  if (statusFilter === "all") {
    wheres.push(inArray(emailSendLog.status, ["failed", "blocked_preflight"]));
  } else {
    wheres.push(eq(emailSendLog.status, statusFilter));
  }

  wheres.push(gte(emailSendLog.queuedAt, since));

  if (sp.feature && sp.feature.trim()) {
    wheres.push(eq(emailSendLog.feature, sp.feature.trim()));
  }
  if (sp.errorCode && sp.errorCode.trim()) {
    wheres.push(eq(emailSendLog.errorCode, sp.errorCode.trim()));
  }
  if (sp.fromUser && /^[0-9a-f-]{36}$/i.test(sp.fromUser.trim())) {
    wheres.push(eq(emailSendLog.fromUserId, sp.fromUser.trim()));
  }

  const cursor = parseCursor(sp.cursor);
  if (cursor && cursor.ts) {
    wheres.push(
      sql`(
        ${emailSendLog.queuedAt} < ${cursor.ts.toISOString()}::timestamptz
        OR (${emailSendLog.queuedAt} = ${cursor.ts.toISOString()}::timestamptz AND ${emailSendLog.id} < ${cursor.id}::uuid)
      )`,
    );
  }

  const where = wheres.length > 0 ? and(...wheres) : undefined;

  const [rowsRaw, featureRows, errorCodeRows, senderRows] = await Promise.all([
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
      .where(where)
      .orderBy(desc(emailSendLog.queuedAt), desc(emailSendLog.id))
      .limit(PAGE_SIZE + 1),
    // Distinct feature names for the filter dropdown — restricted to
    // failure rows in the same range so the dropdown surfaces only what's
    // actually broken.
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

  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rowsTrimmed = hasMore ? rowsRaw.slice(0, PAGE_SIZE) : rowsRaw;
  const last = rowsTrimmed[rowsTrimmed.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.queuedAt, last.id) : null;

  const rows: FailureRow[] = rowsTrimmed.map((r) => ({
    id: r.id,
    queuedAt:
      r.queuedAt instanceof Date ? r.queuedAt.toISOString() : String(r.queuedAt),
    sentAt:
      r.sentAt instanceof Date
        ? r.sentAt.toISOString()
        : r.sentAt
          ? String(r.sentAt)
          : null,
    fromUserId: r.fromUserId,
    fromUserEmailSnapshot: r.fromUserEmailSnapshot,
    fromUserDisplayName: r.fromUserDisplayName ?? null,
    toEmail: r.toEmail,
    toUserId: r.toUserId,
    feature: r.feature,
    featureRecordId: r.featureRecordId,
    subject: r.subject,
    status: r.status,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    graphMessageId: r.graphMessageId,
    httpStatus: r.httpStatus,
    durationMs: r.durationMs,
    requestId: r.requestId,
    retryOfId: r.retryOfId,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    hasAttachments: r.hasAttachments,
    attachmentCount: r.attachmentCount,
    totalSizeBytes: r.totalSizeBytes,
  }));

  const features = featureRows
    .map((r) => r.feature)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const errorCodes = errorCodeRows
    .map((r) => r.errorCode)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const senders = senderRows
    .map((r) => ({ id: r.id, email: r.email }))
    .filter((s) => s.id && s.email);

  const timePrefs = await getCurrentUserTimePrefs();

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Email Failures" },
        ]}
      />
      <h1 className="text-2xl font-semibold">Email failures</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {/* only system-originated email attempts that failed
            (Graph rejected) or were blocked by the mailbox-kind preflight.
            Successful sends and `blocked_e2e` test rows are intentionally
            excluded — see the Email send log for the full feed. */}
        Showing {rows.length}
        {nextCursor ? "+" : ""} {rows.length === 1 ? "failure" : "failures"} in
        the last {rangeLabel(range)}.
      </p>

      <div className="mt-6">
        <RetentionBanner days={730} label="Email send log entries" />
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Range
          <select
            name="from"
            defaultValue={range}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select
            name="status"
            defaultValue={statusFilter}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="all">All failures</option>
            <option value="failed">Failed (Graph error)</option>
            <option value="blocked_preflight">
              Blocked (preflight)
            </option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Feature
          <select
            name="feature"
            defaultValue={sp.feature ?? ""}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">Any</option>
            {features.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Error code
          <select
            name="errorCode"
            defaultValue={sp.errorCode ?? ""}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">Any</option>
            {errorCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Sender
          <select
            name="fromUser"
            defaultValue={sp.fromUser ?? ""}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">Any</option>
            {senders.map((s) => (
              <option key={s.id} value={s.id}>
                {s.email}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Apply
          </button>
          <a
            href="/admin/email-failures"
            className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
          >
            Reset
          </a>
        </div>
      </form>

      <EmailFailuresClient rows={rows} timePrefs={timePrefs} />

      {nextCursor || sp.cursor ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {sp.cursor ? "Showing more results" : `Showing first ${PAGE_SIZE}`}
          </span>
          <div className="flex gap-2">
            {sp.cursor ? (
              <CursorLink sp={sp} cursor={null} range={range} statusFilter={statusFilter}>
                ← Back to start
              </CursorLink>
            ) : null}
            {nextCursor ? (
              <CursorLink
                sp={sp}
                cursor={nextCursor}
                range={range}
                statusFilter={statusFilter}
              >
                Load more →
              </CursorLink>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function CursorLink({
  sp,
  cursor,
  range,
  statusFilter,
  children,
}: {
  sp: EmailFailuresSearchParams;
  cursor: string | null;
  range: RangeValue;
  statusFilter: StatusFilter;
  children: React.ReactNode;
}) {
  const params = new URLSearchParams();
  params.set("from", range);
  params.set("status", statusFilter);
  if (sp.feature) params.set("feature", sp.feature);
  if (sp.errorCode) params.set("errorCode", sp.errorCode);
  if (sp.fromUser) params.set("fromUser", sp.fromUser);
  if (cursor) params.set("cursor", cursor);
  return (
    <a
      href={`/admin/email-failures?${params.toString()}`}
      className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
    >
      {children}
    </a>
  );
}

function rangeToDate(range: RangeValue): Date {
  const now = new Date();
  const ms = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
  }[range];
  return new Date(now.getTime() - ms);
}

function rangeLabel(range: RangeValue): string {
  switch (range) {
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "90d":
      return "90 days";
  }
}
