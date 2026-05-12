import "server-only";
import sgMail from "@sendgrid/mail";
import sgClient from "@sendgrid/client";
import { env, sendgridConfigured } from "@/lib/env";
import { MarketingNotConfiguredError } from "@/lib/marketing/errors";

/**
 * Phase 19 — Lazy-initialized SendGrid clients. Both `@sendgrid/mail` and
 * `@sendgrid/client` are stateful module singletons — calling `setApiKey`
 * once is enough for the lifetime of the lambda.
 *
 * `getSendGrid()` throws `MarketingNotConfiguredError` when env keys are
 * missing so the failure is surfaced at the entry of every code path
 * that depends on SendGrid (no mysterious "Forbidden" deep in the
 * libraries).
 */

let initialized = false;

export function getSendGrid(): { sgMail: typeof sgMail; sgClient: typeof sgClient } {
  if (!sendgridConfigured) {
    const missing: string[] = [];
    if (!env.SENDGRID_API_KEY) missing.push("SENDGRID_API_KEY");
    if (!env.SENDGRID_WEBHOOK_PUBLIC_KEY) missing.push("SENDGRID_WEBHOOK_PUBLIC_KEY");
    if (!env.SENDGRID_UNSUBSCRIBE_GROUP_ID) missing.push("SENDGRID_UNSUBSCRIBE_GROUP_ID");
    throw new MarketingNotConfiguredError(missing);
  }
  if (!initialized) {
    sgMail.setApiKey(env.SENDGRID_API_KEY!);
    sgClient.setApiKey(env.SENDGRID_API_KEY!);
    initialized = true;
  }
  return { sgMail, sgClient };
}

