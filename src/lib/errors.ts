/**
 * Known-error hierarchy. Server actions and route handlers throw these for
 * expected failures; the central `withErrorBoundary` translates them into
 * safe public messages with stable error codes. Anything that isn't a
 * `KnownError` is treated as an internal error and the public response gets
 * a generic message + request id (no stack, no DB detail).
 */

export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMIT"
  | "REAUTH_REQUIRED"
  | "MAILBOX_UNSUPPORTED"
  | "INTERNAL";

export class KnownError extends Error {
  readonly code: ErrorCode;
  /** Safe to display to users. Never include internal IDs or DB strings. */
  readonly publicMessage: string;
  /** Optional structured payload — Zod issues, conflict version, etc. */
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    publicMessage: string,
    internalMessage?: string,
    meta?: Record<string, unknown>,
  ) {
    super(internalMessage ?? publicMessage);
    this.code = code;
    this.publicMessage = publicMessage;
    this.meta = meta;
    this.name = "KnownError";
  }
}

export class ValidationError extends KnownError {
  constructor(publicMessage: string, meta?: Record<string, unknown>) {
    super("VALIDATION", publicMessage, publicMessage, meta);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends KnownError {
  constructor(entityType = "record") {
    super("NOT_FOUND", `That ${entityType} was not found.`, `not_found:${entityType}`);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends KnownError {
  constructor(publicMessage = "You don't have access to that.") {
    super("FORBIDDEN", publicMessage, "forbidden");
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends KnownError {
  constructor(publicMessage: string, meta?: Record<string, unknown>) {
    super("CONFLICT", publicMessage, "conflict", meta);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends KnownError {
  constructor(publicMessage = "Too many attempts. Please try again later.") {
    super("RATE_LIMIT", publicMessage, "rate_limited");
    this.name = "RateLimitError";
  }
}

/**
 * Signals that the actor's federated identity (e.g., Microsoft Graph) needs
 * to re-consent / re-auth before the action can proceed. UI surfaces a
 * Reconnect button on `code === "REAUTH_REQUIRED"`. Distinct class name
 * from the lower-level `ReauthRequiredError` thrown by `graph-token.ts`
 * (that one is a plain `Error`; this one is a `KnownError` consumed by
 * `withErrorBoundary`).
 */
export class ReauthRequiredKnownError extends KnownError {
  constructor(
    publicMessage = "Your Microsoft session expired. Reconnect to continue.",
  ) {
    super("REAUTH_REQUIRED", publicMessage, "reauth_required");
    this.name = "ReauthRequiredKnownError";
  }
}

/**
 * Signals the actor cannot send mail / schedule via Microsoft Graph
 * because their mailbox is not Exchange Online (on-premises, unlicensed,
 * or unverifiable). Fail-closed gate for lead Send email / Schedule
 * meeting; the UI surfaces a bottom-right toast when
 * code === "MAILBOX_UNSUPPORTED" and a bell notification is written
 * server-side. publicMessage carries the preflight explanation.
 */
export class MailboxUnsupportedError extends KnownError {
  constructor(
    publicMessage = "Your mailbox can't send email. Contact MWG IT.",
  ) {
    super("MAILBOX_UNSUPPORTED", publicMessage, "mailbox_unsupported");
    this.name = "MailboxUnsupportedError";
  }
}
