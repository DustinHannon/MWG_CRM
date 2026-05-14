import { NextResponse, type NextRequest } from "next/server";
import { getPermissions } from "@/lib/auth-helpers";
import { withInternalListApi } from "@/lib/api/internal-list";
import {
  listCampaignsCursor,
  type MarketingCampaignStatus,
} from "@/lib/marketing/campaigns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES: ReadonlyArray<MarketingCampaignStatus> = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "cancelled",
];

/**
 * Internal cursor-paginated list endpoint backing the marketing
 * campaigns list client. Session-authenticated (NOT API-key).
 *
 * Accepts:
 *   ?cursor=<opaque>   — null on first page.
 *   ?q                 — search term (matches name / from address).
 *   ?status            — one of draft|scheduled|sending|sent|failed|
 *                        cancelled|all.
 *   ?templateId        — single template uuid.
 *   ?listId            — single list uuid.
 *
 * Returns `{ data, nextCursor, total }`.
 */
export const GET = withInternalListApi(
  { action: "marketing.campaigns.list", auth: "session" },
  async (req: NextRequest, { user }) => {
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingCampaignsView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor");

  const statusRaw = sp.get("status");
  let status: MarketingCampaignStatus | "all" | undefined;
  if (statusRaw === "all") {
    status = "all";
  } else if (
    statusRaw &&
    STATUSES.includes(statusRaw as MarketingCampaignStatus)
  ) {
    status = statusRaw as MarketingCampaignStatus;
  }

  const result = await listCampaignsCursor({
    filters: {
      search: sp.get("q") || undefined,
      status,
      templateId: sp.get("templateId") || undefined,
      listId: sp.get("listId") || undefined,
    },
    cursor,
  });

  return NextResponse.json({
    data: result.data,
    nextCursor: result.nextCursor,
    total: result.total,
  });
  },
);
