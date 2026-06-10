import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { graphAppRequest } from "./graph-app-token";
import type { MailboxKind, PreflightResult } from "./types";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type GraphUserSummary = {
  mail?: string | null;
  assignedLicenses?: Array<{ skuId: string }>;
  onPremisesSyncEnabled?: boolean | null;
  accountEnabled?: boolean | null;
};

type CheckArgs = {
  userId: string;
  entraOid: string | null;
  mailboxKind: string | null;
  mailboxCheckedAt: Date | null;
};

/**
 * Returns the user's mailbox capability, hitting Graph at most once every
 * 24h. Persists the resolution + timestamp on `users` so callers don't have
 * to re-fetch.
 *
 * Audit-logs `email.preflight.ok` or `email.preflight.failed` only when the
 * cache is invalidated and a fresh determination is made — repeated cached
 * reads do not write audit rows.
 */
export async function checkMailboxKind(
  user: CheckArgs,
  opts: { force?: boolean } = {},
): Promise<PreflightResult> {
  const ageMs =
    user.mailboxCheckedAt && user.mailboxKind
      ? Date.now() - user.mailboxCheckedAt.getTime()
      : Number.POSITIVE_INFINITY;

  if (
    !opts.force &&
    user.mailboxKind &&
    ageMs < CACHE_TTL_MS &&
    isMailboxKind(user.mailboxKind)
  ) {
    return buildResult(user.mailboxKind, true);
  }

  if (!user.entraOid) {
    // Breakglass user, manually-seeded user, or test fixture without Entra
    // linkage — record as 'unknown' but don't keep hitting Graph.
    await persistKind(user.userId, "unknown");
    await writeAudit({
      actorId: user.userId,
      action: "email.preflight.failed",
      targetType: "user",
      targetId: user.userId,
      after: { kind: "unknown", reason: "no_entra_oid" },
    });
    return buildResult("unknown", false);
  }

  const summary = await graphAppRequest<GraphUserSummary>(
    "GET",
    `/users/${user.entraOid}?$select=mail,assignedLicenses,onPremisesSyncEnabled,accountEnabled`,
  );

  let kind: MailboxKind = "unknown";
  // `unknown` has two flavors: a definitive determination (user not found,
  // disabled account, no Entra linkage) that's safe to cache for 24h, and a
  // transient/inconclusive one (Graph timeout, network error, 5xx, or
  // not-yet-configured Entra) that we must NOT persist — caching it would pin a
  // healthy mailbox to a failing state until the next login re-probe. Default
  // to non-transient and only flip when the failure is genuinely inconclusive.
  let transient = false;

  if (!summary.ok || !summary.data) {
    if (summary.status === 404) {
      kind = "unknown";
    } else if (summary.status === 0 || summary.status >= 500) {
      // TIMEOUT / NETWORK_ERROR (status 0), Graph 5xx, or the synthetic 503
      // from ENTRA_NOT_CONFIGURED — inconclusive, re-probe next time.
      transient = true;
      if (summary.error?.code !== "ENTRA_NOT_CONFIGURED") {
        // Config gaps don't need a loud log; real transient blips do.
        logger.warn("email_preflight.summary_failed", {
          userId: user.userId,
          status: summary.status,
          errorCode: summary.error?.code,
        });
      }
      kind = "unknown";
    } else {
      logger.warn("email_preflight.summary_failed", {
        userId: user.userId,
        status: summary.status,
        errorCode: summary.error?.code,
      });
      kind = "unknown";
    }
  } else if (summary.data.accountEnabled === false) {
    kind = "unknown";
  } else if (
    !summary.data.assignedLicenses ||
    summary.data.assignedLicenses.length === 0
  ) {
    kind = "not_licensed";
  } else if (summary.data.mail) {
    // Probe mailboxSettings — 200 means EXO mailbox.
    const probe = await graphAppRequest(
      "GET",
      `/users/${user.entraOid}/mailboxSettings`,
    );
    if (probe.ok) {
      kind = "exchange_online";
    } else if (probe.error?.code === "MailboxNotEnabledForRESTAPI") {
      kind = "on_premises";
    } else if (probe.status === 404) {
      kind = "on_premises";
    } else if (probe.status === 0 || probe.status >= 500) {
      // Same transient surface as the summary call — don't cache an
      // inconclusive probe failure; re-probe on the next attempt.
      transient = true;
      logger.warn("email_preflight.probe_failed", {
        userId: user.userId,
        status: probe.status,
        errorCode: probe.error?.code,
      });
      kind = "unknown";
    } else {
      logger.warn("email_preflight.probe_failed", {
        userId: user.userId,
        status: probe.status,
        errorCode: probe.error?.code,
      });
      kind = "unknown";
    }
  } else {
    kind = "on_premises";
  }

  if (transient) {
    // Inconclusive determination (Graph timeout/network/5xx/not-configured):
    // don't persist or audit. Leaving `mailboxCheckedAt` untouched means the
    // next preflight re-probes Graph instead of serving a stale 24h failure.
    return buildResult(kind, false);
  }

  await persistKind(user.userId, kind);
  await writeAudit({
    actorId: user.userId,
    action: kind === "exchange_online" ? "email.preflight.ok" : "email.preflight.failed",
    targetType: "user",
    targetId: user.userId,
    after: { kind },
  });

  return buildResult(kind, false);
}

async function persistKind(userId: string, kind: MailboxKind): Promise<void> {
  await db
    .update(users)
    .set({ mailboxKind: kind, mailboxCheckedAt: new Date() })
    .where(eq(users.id, userId));
}

function isMailboxKind(value: string): value is MailboxKind {
  return (
    value === "exchange_online" ||
    value === "on_premises" ||
    value === "unknown" ||
    value === "not_licensed"
  );
}

function buildResult(kind: MailboxKind, cached: boolean): PreflightResult {
  switch (kind) {
    case "exchange_online":
      return { ok: true, kind, cached };
    case "on_premises":
      return {
        ok: false,
        kind,
        cached,
        message:
          "Your mailbox is hosted on the on-premises Exchange server. Scheduled email features require an Exchange Online mailbox. Contact MWG IT to migrate.",
      };
    case "not_licensed":
      return {
        ok: false,
        kind,
        cached,
        message:
          "Your account doesn't have an Exchange Online license assigned. Contact MWG IT.",
      };
    case "unknown":
    default:
      return {
        ok: false,
        kind: "unknown",
        cached,
        message:
          "Mailbox configuration could not be verified. Try again in a few minutes, or contact MWG IT if it persists.",
      };
  }
}
