import "server-only";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { MarketingNotConfiguredError } from "@/lib/marketing/errors";
import { withRetry } from "@/lib/marketing/with-retry";
import { getSendGrid } from "./client";

/**
 * Push the template designer's exported HTML to SendGrid as a
 * Dynamic Template version. The CRM keeps the canonical `unlayer_design_json`
 * + `rendered_html`; SendGrid keeps the Dynamic Template id + version id so
 * the marketing send path can use `template_id` + `dynamic_template_data`
 * instead of inlining HTML on every send.
 *
 * Flow:
 * First save: POST /v3/templates → captures `id` (template id),
 * then POST /v3/templates/{id}/versions → captures the version id.
 * Subsequent saves: POST /v3/templates/{id}/versions only. The
 * existing template id is preserved.
 *
 * Auditing: callers (sub-agent B's actions) own the `writeAudit` for
 * `marketing.template.pushed_to_sendgrid` so the actor + before/after
 * payload are scoped to the calling action context, not this helper.
 */

interface PushTemplateInput {
  id: string;
  name: string;
  subject: string;
  renderedHtml: string;
  /** Existing SendGrid Dynamic Template id (e.g. `d-…`) or null on first save. */
  sendgridTemplateId: string | null;
}

export interface PushTemplateResult {
  sendgridTemplateId: string;
  sendgridVersionId: string;
}

const TemplateCreateResponseSchema = z
  .object({ id: z.string().min(1) })
  .passthrough();
const VersionCreateResponseSchema = z
  .object({ id: z.string().min(1) })
  .passthrough();

export async function pushTemplateToSendGrid(
  template: PushTemplateInput,
): Promise<PushTemplateResult> {
  const { sgClient } = getSendGrid();

  let sendgridTemplateId = template.sendgridTemplateId;
  if (!sendgridTemplateId) {
    sendgridTemplateId = await createDynamicTemplate(sgClient, template.name);
  }

  const sendgridVersionId = await createTemplateVersion(
    sgClient,
    sendgridTemplateId,
    template,
  );

  logger.info("sendgrid.template.pushed", {
    templateId: template.id,
    sendgridTemplateId,
    sendgridVersionId,
  });

  return { sendgridTemplateId, sendgridVersionId };
}

async function createDynamicTemplate(
  sgClient: ReturnType<typeof getSendGrid>["sgClient"],
  name: string,
): Promise<string> {
  // SendGrid's template name length is bounded (≤100 chars). Truncate
  // defensively so a user-provided 200-char name doesn't 4xx the call.
  const sgName = name.length > 100 ? name.slice(0, 100) : name;
  const result = await withRetry(async () => {
    const [response, body] = await sgClient.request({
      method: "POST",
      url: "/v3/templates",
      body: { name: sgName, generation: "dynamic" },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw asSendGridError(response.statusCode, body);
    }
    return body;
  });
  const parsed = TemplateCreateResponseSchema.safeParse(result);
  if (!parsed.success) {
    throw new MarketingNotConfiguredError([
      "sendgrid_template_create_response_invalid",
    ]);
  }
  return parsed.data.id;
}

async function createTemplateVersion(
  sgClient: ReturnType<typeof getSendGrid>["sgClient"],
  sendgridTemplateId: string,
  template: PushTemplateInput,
): Promise<string> {
  // Generate a stamped version name so the SendGrid console UI shows
  // a useful history; the CRM treats version ids as opaque ids.
  const versionName = `${truncate(template.name, 80)} — ${new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14)}`;
  const plainContent = stripHtmlToPlainText(template.renderedHtml);
  const result = await withRetry(async () => {
    const [response, body] = await sgClient.request({
      method: "POST",
      url: `/v3/templates/${encodeURIComponent(sendgridTemplateId)}/versions`,
      body: {
        template_id: sendgridTemplateId,
        active: 1,
        name: versionName,
        subject: template.subject,
        html_content: template.renderedHtml,
        plain_content: plainContent,
        generate_plain_content: true,
      },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw asSendGridError(response.statusCode, body);
    }
    return body;
  });
  const parsed = VersionCreateResponseSchema.safeParse(result);
  if (!parsed.success) {
    throw new MarketingNotConfiguredError([
      "sendgrid_template_version_response_invalid",
    ]);
  }
  return parsed.data.id;
}

/**
 * Best-effort plain-text fallback for legacy clients that prefer it. We
 * also pass `generate_plain_content: true` so SendGrid will substitute
 * its own conversion when present; this manual strip is the safety net.
 */
function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Build an Error shape with `code` set to the HTTP status so
 * `withRetry` can decide retryability. The thrown error is plain so
 * callers can wrap it with their own typed marketing errors if they
 * want; this helper itself never bubbles a typed marketing error
 * because the caller has the entity context.
 */
function asSendGridError(httpStatus: number, body: unknown): Error & {
  code: number;
  response: { body: unknown };
} {
  const err = new Error(
    `SendGrid API error: HTTP ${httpStatus}`,
  ) as Error & { code: number; response: { body: unknown } };
  err.code = httpStatus;
  err.response = { body };
  return err;
}
