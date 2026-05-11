import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit, ipFromRequest } from "@/lib/security/rate-limit";
import { writeSystemAudit } from "@/lib/audit";

/**
 * Phase 25 §6.2 P1 follow-up — hash the IP before passing it as the
 * rate-limit principal so `rate_limit_buckets.principal` doesn't
 * persist raw IPs for the 1-day retention window. The audit-event
 * row still stores the raw `ipAddress` (for forensics — same as the
 * webhook event receiver) but the limiter bucket gets the hash.
 */
function hashIpForRateLimit(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 25 §6.2 — CSP violation report endpoint.
 *
 * Two shapes are accepted because the browser ecosystem hasn't fully
 * migrated:
 *
 *   1. Legacy `report-uri` format (current default in `src/proxy.ts`):
 *      Content-Type: application/csp-report
 *      Body: { "csp-report": { "document-uri": "...", ... } }
 *
 *   2. Reporting API `report-to` format:
 *      Content-Type: application/reports+json
 *      Body: [{ type: "csp-violation", body: { ... }, ... }]
 *
 * Both shapes funnel into the same audit event so the security review
 * doesn't have to know which UA dialect produced it.
 *
 * Defense-in-depth:
 * - Per-IP rate limit (sliding window, 60-second).
 * - Body capped at 32 KB before parsing (CSP reports are tiny; anything
 *   larger is abuse).
 * - Audit event includes only directive + blocked-uri + document-uri +
 *   source-file. The raw `original-policy` is NOT persisted — we know
 *   the policy server-side and the browser-side dump just bloats audit
 *   rows.
 *
 * The endpoint is public (no auth) — browsers POST here when the CSP
 * blocks a resource and they MUST be able to do so without a session
 * cookie. `src/proxy.ts` PUBLIC_PATH_PREFIXES exempts /api/v1/security/.
 */

const MAX_BODY_BYTES = 32 * 1024;

const legacyReportSchema = z.object({
  "csp-report": z
    .object({
      "document-uri": z.string().max(2048).optional(),
      "referrer": z.string().max(2048).optional(),
      "violated-directive": z.string().max(256).optional(),
      "effective-directive": z.string().max(256).optional(),
      "blocked-uri": z.string().max(2048).optional(),
      "source-file": z.string().max(2048).optional(),
      "line-number": z.number().int().nonnegative().optional(),
      "column-number": z.number().int().nonnegative().optional(),
      "status-code": z.number().int().nonnegative().optional(),
      "disposition": z.string().max(32).optional(),
    })
    .passthrough(),
});

const reportToReportSchema = z
  .object({
    type: z.string().max(64),
    age: z.number().optional(),
    url: z.string().max(2048).optional(),
    user_agent: z.string().max(512).optional(),
    body: z
      .object({
        documentURL: z.string().max(2048).optional(),
        referrer: z.string().max(2048).optional(),
        blockedURL: z.string().max(2048).optional(),
        effectiveDirective: z.string().max(256).optional(),
        originalPolicy: z.string().max(8192).optional(),
        sourceFile: z.string().max(2048).optional(),
        lineNumber: z.number().int().nonnegative().optional(),
        columnNumber: z.number().int().nonnegative().optional(),
        disposition: z.string().max(32).optional(),
      })
      .passthrough(),
  })
  .passthrough();

// Phase 25 §6.2 P1 follow-up — cap reports-per-request hard at 5.
// The Reporting API permits batching up to ~50; combined with the
// 60/min/IP rate limit that's 3000 audit rows per minute per source IP
// — enough for one misbehaving browser extension to flood audit_log.
// Five is generous: in practice browsers emit 1-2 reports per page
// load when a violation occurs.
const MAX_NORMALIZED_REPORTS_PER_REQUEST = 5;
const reportToBatchSchema = z.array(reportToReportSchema).max(50);

interface NormalizedReport {
  directive: string;
  blockedUri: string;
  documentUri: string;
  sourceFile: string;
  lineNumber: number | null;
  disposition: string;
}

function normalizeLegacy(
  parsed: z.infer<typeof legacyReportSchema>,
): NormalizedReport {
  const r = parsed["csp-report"];
  return {
    directive:
      r["effective-directive"] ?? r["violated-directive"] ?? "unknown",
    blockedUri: r["blocked-uri"] ?? "",
    documentUri: r["document-uri"] ?? "",
    sourceFile: r["source-file"] ?? "",
    lineNumber: r["line-number"] ?? null,
    disposition: r["disposition"] ?? "enforce",
  };
}

function normalizeReportTo(
  parsed: z.infer<typeof reportToReportSchema>,
): NormalizedReport | null {
  // Browsers send a mix of report types on the same endpoint — we only
  // record CSP violations here.
  if (parsed.type !== "csp-violation") return null;
  const b = parsed.body;
  return {
    directive: b.effectiveDirective ?? "unknown",
    blockedUri: b.blockedURL ?? "",
    documentUri: b.documentURL ?? parsed.url ?? "",
    sourceFile: b.sourceFile ?? "",
    lineNumber: b.lineNumber ?? null,
    disposition: b.disposition ?? "enforce",
  };
}

export async function POST(req: NextRequest) {
  const ip = ipFromRequest(req);

  // 1. Rate limit per IP. Sliding 60s window.
  const rl = await rateLimit(
    { kind: "csp_report", principal: hashIpForRateLimit(ip) },
    env.RATE_LIMIT_CSP_REPORT_PER_IP_PER_MINUTE,
    60,
  );
  if (!rl.allowed) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@csp",
      action: "csp.violation.rate_limited",
      targetType: "csp_report",
      ipAddress: ip,
      after: {
        limitPerMinute: env.RATE_LIMIT_CSP_REPORT_PER_IP_PER_MINUTE,
      },
    });
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter ?? 60) },
    });
  }

  // 2. Body size guard. CSP reports are < 4 KB in practice.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // 3. Parse. Browsers send either application/csp-report (legacy) or
  // application/reports+json (Reporting API). Read as text so we can
  // safely fall through both schemas.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (err) {
    // optional-parse: body read can fail on aborted connections; ignore.
    logger.warn("csp.report.body_read_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse(null, { status: 400 });
  }
  // Phase 25 §6.2 P2 follow-up — measure in BYTES (not chars) so
  // multi-byte UTF-8 reports don't slip past the post-parse check
  // when content-length is missing or unreliable. The earlier
  // content-length gate is bytes already.
  const byteLength = Buffer.byteLength(bodyText, "utf8");
  if (byteLength === 0 || byteLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    // optional-parse: malformed body → 400.
    return new NextResponse(null, { status: 400 });
  }

  const normalized: NormalizedReport[] = [];
  const legacy = legacyReportSchema.safeParse(raw);
  if (legacy.success) {
    normalized.push(normalizeLegacy(legacy.data));
  } else {
    const batch = reportToBatchSchema.safeParse(raw);
    if (batch.success) {
      for (const entry of batch.data) {
        const n = normalizeReportTo(entry);
        if (n) normalized.push(n);
      }
    } else {
      return new NextResponse(null, { status: 400 });
    }
  }

  // 4. Emit audit events. One per normalized report, hard-capped at
  // MAX_NORMALIZED_REPORTS_PER_REQUEST so a batched Reporting API
  // payload can't flood the audit log even within rate-limit budget.
  // Excess entries are silently dropped — the rate limiter ensures
  // a misbehaving source still gets bounded, and the typical case
  // emits 1-2 reports anyway.
  const toEmit = normalized.slice(0, MAX_NORMALIZED_REPORTS_PER_REQUEST);
  for (const r of toEmit) {
    await writeSystemAudit({
      actorEmailSnapshot: "system@csp",
      action: "csp.violation.reported",
      targetType: "csp_report",
      ipAddress: ip,
      after: {
        directive: r.directive,
        blockedUri: r.blockedUri,
        documentUri: r.documentUri,
        sourceFile: r.sourceFile,
        lineNumber: r.lineNumber,
        disposition: r.disposition,
        userAgent: req.headers.get("user-agent")?.slice(0, 256) ?? null,
      },
    });
  }

  return new NextResponse(null, { status: 204 });
}
