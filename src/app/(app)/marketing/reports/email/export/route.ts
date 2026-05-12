import { and, desc, eq, gte, lte } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { marketingCampaigns } from "@/db/schema/marketing-campaigns";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Marketing email report export. Streams an .xlsx file with
 * aggregate KPIs + per-campaign rows for the requested window.
 *
 * Authenticated via the standard cookie-based session — same gate as
 * the report page itself. Marketing permission required.
 */
export async function GET(req: Request) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canManageMarketing) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const fromDate = fromParam ? new Date(fromParam) : thirtyDaysAgo;
  const toDate = toParam ? new Date(toParam) : today;
  const toDateEnd = new Date(toDate);
  toDateEnd.setHours(23, 59, 59, 999);

  const rows = await db
    .select({
      id: marketingCampaigns.id,
      name: marketingCampaigns.name,
      status: marketingCampaigns.status,
      sentAt: marketingCampaigns.sentAt,
      totalRecipients: marketingCampaigns.totalRecipients,
      totalSent: marketingCampaigns.totalSent,
      totalDelivered: marketingCampaigns.totalDelivered,
      totalOpened: marketingCampaigns.totalOpened,
      totalClicked: marketingCampaigns.totalClicked,
      totalBounced: marketingCampaigns.totalBounced,
      totalUnsubscribed: marketingCampaigns.totalUnsubscribed,
    })
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.isDeleted, false),
        gte(marketingCampaigns.sentAt, fromDate),
        lte(marketingCampaigns.sentAt, toDateEnd),
      ),
    )
    .orderBy(desc(marketingCampaigns.sentAt))
    .limit(2000);

  const wb = new ExcelJS.Workbook();
  wb.creator = "MWG CRM";
  wb.created = new Date();

  const ws = wb.addWorksheet("Campaigns");
  ws.columns = [
    { header: "Campaign", key: "name", width: 36 },
    { header: "Status", key: "status", width: 14 },
    { header: "Sent at", key: "sentAt", width: 22 },
    { header: "Recipients", key: "totalRecipients", width: 14 },
    { header: "Sent", key: "totalSent", width: 12 },
    { header: "Delivered", key: "totalDelivered", width: 14 },
    { header: "Opened", key: "totalOpened", width: 12 },
    { header: "Clicked", key: "totalClicked", width: 12 },
    { header: "Bounced", key: "totalBounced", width: 12 },
    { header: "Unsubscribed", key: "totalUnsubscribed", width: 14 },
    { header: "Open rate", key: "openRate", width: 12 },
    { header: "Click rate", key: "clickRate", width: 12 },
  ];
  ws.getRow(1).font = { bold: false };
  ws.getRow(1).alignment = { vertical: "middle" };

  for (const r of rows) {
    const safe = (n: number, d: number): number => (d === 0 ? 0 : n / d);
    ws.addRow({
      name: r.name,
      status: r.status,
      sentAt: r.sentAt,
      totalRecipients: r.totalRecipients,
      totalSent: r.totalSent,
      totalDelivered: r.totalDelivered,
      totalOpened: r.totalOpened,
      totalClicked: r.totalClicked,
      totalBounced: r.totalBounced,
      totalUnsubscribed: r.totalUnsubscribed,
      openRate: safe(r.totalOpened, r.totalDelivered),
      clickRate: safe(r.totalClicked, r.totalDelivered),
    });
  }

  // Format the rate columns as percentages.
  ws.getColumn("openRate").numFmt = "0.0%";
  ws.getColumn("clickRate").numFmt = "0.0%";
  ws.getColumn("sentAt").numFmt = "yyyy-mm-dd hh:mm";

  // ExcelJS returns a Buffer-like value; the Response constructor
  // accepts it as the body verbatim.
  const buffer = await wb.xlsx.writeBuffer();

  logger.info("marketing.report.export", {
    userId: user.id,
    rowCount: rows.length,
    from: fromDate.toISOString(),
    to: toDateEnd.toISOString(),
  });

  const filename = `marketing-email-report-${fromDate
    .toISOString()
    .slice(0, 10)}-to-${toDate.toISOString().slice(0, 10)}.xlsx`;

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
