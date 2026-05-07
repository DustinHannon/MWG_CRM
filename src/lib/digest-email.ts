import "server-only";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { eq } from "drizzle-orm";
import { graphFetchAs, ReauthRequiredError } from "@/lib/graph-token";

export interface DigestRecord {
  id: string;
  name: string;
  company: string | null;
  ownerName: string | null;
  link: string;
}

interface DigestArgs {
  userId: string;
  viewName: string;
  records: DigestRecord[];
  appUrl?: string;
}

/**
 * Phase 3H — render minimal HTML digest and send via Microsoft Graph
 * /me/sendMail using the user's stored refresh token. Sent FROM the user
 * TO themselves (saveToSentItems off — they don't need to see digests
 * cluttering Sent Items).
 *
 * On 401/403 from Graph (token revoked / consent withdrawn):
 *   - log
 *   - throw ReauthRequiredError so the caller can create a reconnect
 *     in-app notification and skip the user.
 */
export async function sendDigestEmail(args: DigestArgs): Promise<void> {
  const [user] = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, args.userId))
    .limit(1);
  if (!user) throw new Error(`User ${args.userId} not found`);

  const html = renderDigestHtml({
    displayName: user.displayName,
    viewName: args.viewName,
    records: args.records,
    appUrl: args.appUrl ?? "https://mwg-crm.vercel.app",
  });

  const sendBody = {
    message: {
      subject: `${args.records.length} new lead${args.records.length === 1 ? "" : "s"} in "${args.viewName}"`,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: user.email } }],
    },
    saveToSentItems: false,
  };

  await graphFetchAs<unknown>(args.userId, "/me/sendMail", {
    method: "POST",
    body: JSON.stringify(sendBody),
  });
}

function renderDigestHtml(args: {
  displayName: string;
  viewName: string;
  records: DigestRecord[];
  appUrl: string;
}): string {
  const rows = args.records
    .map(
      (r) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e6e6e6;">
            <a href="${args.appUrl}${r.link}" style="color:#0a2342;text-decoration:none;font-weight:600;">${escape(
              r.name,
            )}</a>
            ${r.company ? `<div style="color:#666;font-size:12px;margin-top:2px;">${escape(r.company)}</div>` : ""}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e6e6e6;color:#666;font-size:13px;">${escape(
            r.ownerName ?? "—",
          )}</td>
        </tr>
      `,
    )
    .join("");

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e6e6e6;overflow:hidden;">
    <div style="padding:18px 22px;background:#0a2342;color:#fff;">
      <p style="margin:0;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.7;">Morgan White Group</p>
      <p style="margin:4px 0 0;font-size:18px;font-weight:600;">MWG CRM digest</p>
    </div>
    <div style="padding:22px;">
      <p style="margin:0 0 16px;font-size:14px;color:#333;">Hi ${escape(args.displayName.split(" ")[0])},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#333;">
        ${args.records.length} new lead${args.records.length === 1 ? " matches" : "s match"} your saved view
        <strong style="color:#0a2342;">${escape(args.viewName)}</strong>:
      </p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e6e6e6;border-radius:6px;overflow:hidden;">
        ${rows}
      </table>
      <p style="margin:18px 0 0;font-size:12px;color:#999;">
        Manage your subscriptions on the
        <a href="${args.appUrl}/settings#notifications" style="color:#2b6cb0;">/settings</a> page.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { ReauthRequiredError };
