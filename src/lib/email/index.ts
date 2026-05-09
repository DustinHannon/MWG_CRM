export { sendEmailAs } from "./send";
export { checkMailboxKind } from "./preflight";
export { isGraphAppConfigured } from "./graph-app-token";
export type {
  EmailAttachment,
  EmailRecipient,
  MailboxKind,
  PreflightResult,
  RecipientOutcome,
  SendOptions,
  SendResult,
} from "./types";
export { EmailNotConfiguredError } from "./types";
