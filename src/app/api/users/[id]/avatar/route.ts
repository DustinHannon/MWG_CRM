import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { requireSession } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROXY_CACHE_HEADER = "private, max-age=300";
const ABSENT_CACHE_HEADER = "private, max-age=60";

/**
 * Authenticated avatar proxy. Reads users.photo_blob_url (a private
 * Vercel Blob URL set by graph-photo.ts) and streams the bytes after
 * verifying the requester is signed in.
 *
 * Why a proxy: the Blob store is private. Direct <img src={blobUrl}>
 * 401s without an Authorization header. The proxy holds the
 * BLOB_READ_WRITE_TOKEN server-side and streams to the browser.
 *
 * Auth model: any signed-in user can fetch any other user's avatar.
 * That matches the in-app behavior of seeing colleagues in lead lists,
 * audit logs, etc. Not gated by can_view_all_records.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const { id } = await ctx.params;

  const row = await db
    .select({ photoBlobUrl: users.photoBlobUrl })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  const blobUrl = row[0]?.photoBlobUrl ?? null;
  if (!blobUrl) {
    return new NextResponse(null, {
      status: 404,
      headers: { "cache-control": ABSENT_CACHE_HEADER },
    });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    logger.error("avatar_proxy.no_blob_token", { userId: id });
    return new NextResponse(null, { status: 503 });
  }

  const upstream = await fetch(blobUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!upstream.ok || !upstream.body) {
    logger.warn("avatar_proxy.upstream_fetch_failed", {
      userId: id,
      status: upstream.status,
    });
    return new NextResponse(null, {
      status: upstream.status === 404 ? 404 : 502,
    });
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": PROXY_CACHE_HEADER,
    },
  });
}
