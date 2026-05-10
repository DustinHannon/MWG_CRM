import { KnownError } from "@/lib/errors";

/**
 * Phase 19 — Marketing-domain typed errors.
 *
 * Subclasses of `KnownError` so `withErrorBoundary` translates them to
 * stable user-facing codes/messages. Use these for every expected
 * marketing failure (locked template, suppressed recipient, webhook
 * signature mismatch). Bare `throw new Error()` is reserved for true
 * invariant violations (a campaign reaching `sending` with no
 * template_id, etc.).
 */

export class TemplateLockedError extends KnownError {
  /**
   * @param lockedByName Display name of the user currently holding the
   *   lock — surfaced in the toast so the editor knows who to ask.
   */
  constructor(lockedByName: string, lockedByUserId?: string) {
    super(
      "CONFLICT",
      `${lockedByName} is currently editing this template. Try again in a moment.`,
      "template_locked",
      { lockedByUserId },
    );
    this.name = "TemplateLockedError";
  }
}

/**
 * The send pipeline filters suppressions before calling SendGrid, so
 * this is for the rare admin "send to one address" debug path. UI
 * surfaces a clean message instead of a raw 4xx.
 */
export class SuppressedRecipientError extends KnownError {
  constructor(email: string, suppressionType: string) {
    super(
      "VALIDATION",
      `${email} is on the marketing suppression list (${suppressionType}). They will not receive marketing email.`,
      "suppressed_recipient",
      { email, suppressionType },
    );
    this.name = "SuppressedRecipientError";
  }
}

/**
 * Webhook receiver throws this when the SendGrid signature header is
 * missing or fails ECDSA verification. Public response is always 401
 * — the route handler catches this and returns it directly without
 * leaking which check failed.
 */
export class WebhookSignatureError extends Error {
  readonly reason:
    | "missing_headers"
    | "verify_failed"
    | "no_public_key"
    | "replay_rejected"; // Phase 20 — timestamp outside freshness window
  constructor(
    reason:
      | "missing_headers"
      | "verify_failed"
      | "no_public_key"
      | "replay_rejected",
  ) {
    super(`SendGrid webhook signature failed: ${reason}`);
    this.name = "WebhookSignatureError";
    this.reason = reason;
  }
}

/**
 * Marketing send pipeline aborted before reaching SendGrid. Most common
 * cause: SENDGRID_API_KEY missing in env (e.g. dev environment).
 */
export class MarketingNotConfiguredError extends KnownError {
  constructor(missing: string[]) {
    super(
      "INTERNAL",
      "Marketing email is not configured on this environment. Contact an administrator.",
      `marketing_not_configured: missing ${missing.join(", ")}`,
      { missing },
    );
    this.name = "MarketingNotConfiguredError";
  }
}

/**
 * SendGrid API returned a non-2xx status. We only surface the public
 * code (4xx vs 5xx); raw response bodies and headers are NEVER copied
 * onto the error so they don't leak into logs.
 */
export class SendGridApiError extends KnownError {
  readonly httpStatus: number;
  readonly sendgridErrorCode: string | null;
  constructor(
    httpStatus: number,
    sendgridErrorCode: string | null,
    publicMessage = "The email service rejected the request.",
  ) {
    super(
      httpStatus >= 500 ? "INTERNAL" : "VALIDATION",
      publicMessage,
      `sendgrid_api_error: http=${httpStatus} code=${sendgridErrorCode ?? "unknown"}`,
      { httpStatus, sendgridErrorCode },
    );
    this.name = "SendGridApiError";
    this.httpStatus = httpStatus;
    this.sendgridErrorCode = sendgridErrorCode;
  }
}
