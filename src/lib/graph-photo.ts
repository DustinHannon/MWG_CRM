import "server-only";
import { logger } from "@/lib/logger";
import { put } from "@vercel/blob";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { graphFetchBinaryAs, ReauthRequiredError } from "@/lib/graph-token";

const PHOTO_TTL_HOURS = 24;

/**
 * Cache the user's Microsoft profile photo to Vercel Blob and store the URL
 * on users.photo_blob_url. Refreshes once every PHOTO_TTL_HOURS.
 *
 * 404 from Graph (no photo set) is treated as a deliberate "no photo"
 * and we mark the timestamp so we don't retry for a day.
 * Reauth errors are swallowed — the photo is non-critical and we don't
 * want the dashboard to fail just because a refresh token expired.
 */
export async function refreshUserPhotoIfStale(userId: string): Promise<void> {
  const u = await db
    .select({
      photoBlobUrl: users.photoBlobUrl,
      photoSyncedAt: users.photoSyncedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = u[0];
  if (!row) return;

  if (row.photoSyncedAt) {
    const ageMs = Date.now() - new Date(row.photoSyncedAt).getTime();
    if (ageMs < PHOTO_TTL_HOURS * 60 * 60 * 1000) return;
  }

  try {
    const res = await graphFetchBinaryAs(userId, "/me/photo/$value");
    if (res.status === 404) {
      await db
        .update(users)
        .set({ photoBlobUrl: null, photoSyncedAt: sql`now()` })
        .where(eq(users.id, userId));
      return;
    }
    if (!res.ok) {
      logger.warn("graph_photo.non_ok", {
        userId,
        status: res.status,
      });
      return;
    }

    const buf = await res.arrayBuffer();
    const blob = await put(`users/${userId}/photo.jpg`, Buffer.from(buf), {
      access: "private",
      addRandomSuffix: false,
      // The pathname is deterministic per user and refreshed every
      // PHOTO_TTL_HOURS, so every refresh after the first overwrites
      // the same blob. @vercel/blob v2 defaults allowOverwrite:false
      // and throws "This blob already exists" — which silently broke
      // all photo refreshes after the first write. Overwrite is the
      // intended behaviour here.
      allowOverwrite: true,
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    });

    await db
      .update(users)
      .set({ photoBlobUrl: blob.url, photoSyncedAt: sql`now()` })
      .where(eq(users.id, userId));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      // Non-fatal — the dashboard handles missing photos gracefully.
      logger.warn("graph_photo.reauth_required", {
        userId,
        errorMessage: err.message,
      });
      return;
    }
    logger.warn("graph_photo.failed", {
      userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
