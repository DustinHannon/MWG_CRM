/**
 * shared types for the generic email module.
 *
 * Naming: `email_send_log` is the system-level audit; `audit_log` rows are
 * action-level. Two tables, one source of truth (`sendEmailAs` writes both).
 */

export type MailboxKind =
  | "exchange_online"
  | "on_premises"
  | "unknown"
  | "not_licensed";

export type EmailRecipient = {
  email: string;
  userId?: string | null;
};

export type EmailAttachment = {
  filename: string;
  contentType: string;
  bytes: Buffer | Uint8Array;
};

export type SendOptions = {
  fromUserId: string;
  to: EmailRecipient[];
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
  feature: string;
  featureRecordId?: string;
  metadata?: Record<string, unknown>;
};

export type RecipientOutcome = {
  email: string;
  status: "sent" | "failed" | "blocked_preflight" | "blocked_e2e";
  errorCode?: string;
  errorMessage?: string;
  logId: string;
};

export type SendResult = {
  ok: boolean;
  perRecipient: RecipientOutcome[];
  graphRequestId?: string;
  durationMs: number;
};

export type PreflightResult = {
  ok: boolean;
  kind: MailboxKind;
  message?: string;
  cached: boolean;
};

export class EmailNotConfiguredError extends Error {
  readonly code = "ENTRA_NOT_CONFIGURED";
  constructor(message = "Microsoft Graph application credentials are not configured") {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}
