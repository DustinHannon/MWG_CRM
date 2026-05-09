import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Verify a cron request's Bearer token against CRON_SECRET using a
 * timing-safe compare. Returns null on success; returns a NextResponse
 * 401 the caller should return as-is on failure.
 *
 * Usage:
 *   const unauth = requireCronAuth(req);
 *   if (unauth) return unauth;
 *   // ... handler body
 *
 * Encoding note: both inputs are converted to UTF-8 bytes for the
 * compare. The pre-check uses Buffer.byteLength so a multi-byte
 * character difference doesn't smuggle past the equal-length
 * precondition that timingSafeEqual requires.
 */
export function requireCronAuth(req: Request): NextResponse | null {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return unauthorized();
  }
  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) {
    return unauthorized();
  }
  if (!timingSafeEqual(providedBytes, expectedBytes)) {
    return unauthorized();
  }
  return null;
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Unauthorized" },
    { status: 401 },
  );
}
